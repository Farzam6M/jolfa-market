-- ════════════════════════════════════════════════════════════════════
-- Review architecture correction: reviews represent the PRODUCT itself
-- (the shared global catalog entry), not one store's specific offer of
-- it. The 20260801000000_product_storeproduct_split migration moved
-- Review onto StoreProduct along with Cart/Wishlist/OrderItem — that was
-- correct for those three, but wrong for Review. This migration moves
-- Review's FK from store_products back to products, preserving every
-- existing review row (each row's new productId is derived from the
-- store_products row it used to point at).
-- ════════════════════════════════════════════════════════════════════

-- ── Step 1: add the new column (nullable until backfilled).
ALTER TABLE "reviews" ADD COLUMN "productId" TEXT;

-- ── Step 2: backfill — resolve each review's global Product through the
-- store_products row it currently points at.
UPDATE "reviews" r
SET "productId" = sp."productId"
FROM "store_products" sp
WHERE sp.id = r."storeProductId";

-- ── Step 3: lock down productId now every row has one.
ALTER TABLE "reviews" ALTER COLUMN "productId" SET NOT NULL;

-- ── Step 4: drop the old store_products-pointing FK/unique-index/column.
ALTER TABLE "reviews" DROP CONSTRAINT "reviews_productId_fkey"; -- old name, was actually on storeProductId (see 20260801000000 migration)
DROP INDEX "reviews_storeProductId_userId_key";
ALTER TABLE "reviews" DROP COLUMN "storeProductId";

-- ── Step 5: constraints for the new productId column.
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "reviews_productId_userId_key" ON "reviews"("productId", "userId");
