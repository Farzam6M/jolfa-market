-- ════════════════════════════════════════════════════════════════════
-- Split the old single-table "products" (which was really a per-store
-- offer: storeId + price + stock all on one row) into:
--   products        -> the GLOBAL catalog entry (name/brand/model/
--                       capacity/color/description/specifications/slug/
--                       categoryId/identityKey)
--   store_products  -> the renamed original table, now holding only the
--                       store-specific offer (storeId, productId FK back
--                       to the new products table, price/stock/etc.)
--
-- Every row that exists today in "products" becomes exactly one row in
-- the new "products" table AND one row in "store_products" pointing at
-- it — so existing data is preserved 1:1, nothing is deleted. Rows whose
-- (normalized name, brand) already match each other are merged into a
-- single new global Product (best-effort backfill; model/capacity/color
-- didn't exist as columns before this migration so they can't factor
-- into the historical merge — see products.service.js buildIdentityKey
-- for the going-forward rule, which does include them).
-- ════════════════════════════════════════════════════════════════════

-- ── Step 1: rename the existing table. The row ids are unchanged, so
-- every existing FK in product_images / wholesale_tiers / cart_items /
-- wishlist_items / reviews / order_items still points at the correct
-- row after this rename — only the referenced table's name changes.
ALTER TABLE "products" RENAME TO "store_products";
ALTER TABLE "store_products" RENAME CONSTRAINT "products_pkey" TO "store_products_pkey";

-- ── Step 2: new columns on store_products (nullable/no-default fields
-- first; productId is backfilled below then locked down).
ALTER TABLE "store_products" ADD COLUMN "warranty"     TEXT;
ALTER TABLE "store_products" ADD COLUMN "shippingTime" TEXT;
ALTER TABLE "store_products" ADD COLUMN "discount"     INTEGER;
ALTER TABLE "store_products" ADD COLUMN "productId"    TEXT;

-- ── Step 3: create the new global "products" table.
CREATE TABLE "products" (
    "id"             TEXT NOT NULL,
    "categoryId"     TEXT,
    "name"           TEXT NOT NULL,
    "slug"           TEXT NOT NULL,
    "brand"          TEXT,
    "model"          TEXT,
    "capacity"       TEXT,
    "color"          TEXT,
    "description"    TEXT,
    "specifications" JSONB,
    "identityKey"    TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- ── Step 4: backfill — group existing store_products rows by normalized
-- (name, brand), create one global Product per group, point every row
-- in that group at it. Uses an extension-free UUID (md5 of random +
-- clock, cast to uuid) so this doesn't depend on pgcrypto/uuid-ossp
-- being installed.
DO $$
DECLARE
  r RECORD;
  new_id TEXT;
  base_key TEXT;
  final_key TEXT;
  suffix INT;
BEGIN
  FOR r IN
    SELECT
      lower(regexp_replace(trim(sp.name), '\s+', ' ', 'g'))                 AS norm_name,
      lower(regexp_replace(trim(coalesce(sp.brand, '')), '\s+', ' ', 'g'))  AS norm_brand,
      MIN(sp.name)        AS sample_name,
      MIN(sp.brand)       AS sample_brand,
      MIN(sp.description) AS sample_description,
      MIN(sp."categoryId") AS sample_category,
      MIN(sp.slug)        AS sample_slug
    FROM "store_products" sp
    GROUP BY 1, 2
  LOOP
    new_id := (md5(random()::text || clock_timestamp()::text))::uuid::text;

    -- Going-forward identityKey format is normalized name|brand|model|capacity|color
    -- (see products.service.js buildIdentityKey) — model/capacity/color are
    -- unknown for pre-existing rows, so they're left empty here.
    base_key := r.norm_name || '|' || r.norm_brand || '||';
    final_key := base_key;
    suffix := 0;
    WHILE EXISTS (SELECT 1 FROM "products" WHERE "identityKey" = final_key) LOOP
      suffix := suffix + 1;
      final_key := base_key || '#' || suffix::text;
    END LOOP;

    INSERT INTO "products" (id, "categoryId", name, slug, brand, description, "identityKey", "createdAt", "updatedAt")
    VALUES (
      new_id,
      r.sample_category,
      r.sample_name,
      r.sample_slug || '-' || substr(md5(random()::text), 1, 6),
      r.sample_brand,
      r.sample_description,
      final_key,
      now(),
      now()
    );

    UPDATE "store_products" sp
    SET "productId" = new_id
    WHERE lower(regexp_replace(trim(sp.name), '\s+', ' ', 'g')) = r.norm_name
      AND lower(regexp_replace(trim(coalesce(sp.brand, '')), '\s+', ' ', 'g')) = r.norm_brand
      AND sp."productId" IS NULL;
  END LOOP;
END $$;

-- ── Step 5: lock down productId now every row has one.
ALTER TABLE "store_products" ALTER COLUMN "productId" SET NOT NULL;

-- ── Step 6: drop the fields that moved to the global Product table.
-- (This also implicitly drops the old products_slug_key unique index,
-- the products_categoryId_idx index, and the categoryId FK — all of
-- which lived solely on these columns.)
ALTER TABLE "store_products" DROP COLUMN "name";
ALTER TABLE "store_products" DROP COLUMN "slug";
ALTER TABLE "store_products" DROP COLUMN "brand";
ALTER TABLE "store_products" DROP COLUMN "description";
ALTER TABLE "store_products" DROP COLUMN "categoryId";

-- ── Step 7: constraints/indexes for the new products table.
CREATE UNIQUE INDEX "products_slug_key" ON "products"("slug");
CREATE UNIQUE INDEX "products_identityKey_key" ON "products"("identityKey");
CREATE INDEX "products_categoryId_idx" ON "products"("categoryId");
ALTER TABLE "products" ADD CONSTRAINT "products_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Step 8: constraints/indexes for store_products.productId.
ALTER TABLE "store_products" ADD CONSTRAINT "store_products_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "store_products_productId_idx" ON "store_products"("productId");
CREATE UNIQUE INDEX "store_products_storeId_productId_key" ON "store_products"("storeId", "productId");

-- ── Step 9: rename the FK columns on every dependent table to match the
-- new relation name. Same underlying ids (store_products.id), so this is
-- a pure rename — no data movement, no risk of mismatched rows.
ALTER TABLE "product_images"  RENAME COLUMN "productId" TO "storeProductId";
ALTER TABLE "wholesale_tiers" RENAME COLUMN "productId" TO "storeProductId";
ALTER TABLE "cart_items"      RENAME COLUMN "productId" TO "storeProductId";
ALTER TABLE "wishlist_items"  RENAME COLUMN "productId" TO "storeProductId";
ALTER TABLE "reviews"         RENAME COLUMN "productId" TO "storeProductId";
ALTER TABLE "order_items"     RENAME COLUMN "productId" TO "storeProductId";

-- Rename the old unique/compound indexes that referenced the old column
-- name so their definitions (and any tooling introspecting by name)
-- stay meaningful. The underlying column rename above already updated
-- what they're built on; this only renames the constraint/index labels.
ALTER INDEX "cart_items_cartId_productId_key" RENAME TO "cart_items_cartId_storeProductId_key";
ALTER INDEX "wishlist_items_userId_productId_key" RENAME TO "wishlist_items_userId_storeProductId_key";
ALTER INDEX "reviews_productId_userId_key" RENAME TO "reviews_storeProductId_userId_key";
ALTER INDEX "product_images_productId_idx" RENAME TO "product_images_storeProductId_idx";
ALTER INDEX "wholesale_tiers_productId_idx" RENAME TO "wholesale_tiers_storeProductId_idx";
