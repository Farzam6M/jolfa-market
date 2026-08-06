-- Adds Store.mainCategoryId: the Store's single authoritative Category,
-- used to enforce "a store's products may only use its own main category"
-- (see products.service#assertProductCategoryMatchesStore). This is
-- separate from the pre-existing, unrelated free-text "categoryTag"
-- column, which is left untouched.
--
-- Safety notes (no existing data is overwritten or deleted):
--   * Column is added NULLable — no existing store row is invalidated.
--   * The backfill below only fills in stores that currently have NO
--     mainCategoryId AND whose existing products all unambiguously point
--     at exactly one non-null category. Any store with zero products, or
--     with products spread across 2+ distinct categories, is left NULL on
--     purpose ("don't guess") — an admin must set it explicitly via the
--     admin panel (PATCH /stores/:id or /stores (create)).
--   * Until mainCategoryId is set, a store is NOT yet restricted by the new
--     business rule — this migration cannot itself break any existing
--     store/product, it only opens the door for the rule to start applying
--     once a category is assigned.

ALTER TABLE "stores" ADD COLUMN "mainCategoryId" TEXT;

-- Backfill: one UPDATE, one unambiguous category per store, computed from
-- that store's own existing products.
UPDATE "stores" AS s
SET "mainCategoryId" = unambiguous."categoryId"
FROM (
  SELECT "storeId", MIN("categoryId") AS "categoryId"
  FROM "products"
  WHERE "categoryId" IS NOT NULL
  GROUP BY "storeId"
  HAVING COUNT(DISTINCT "categoryId") = 1
) AS unambiguous
WHERE s."id" = unambiguous."storeId"
  AND s."mainCategoryId" IS NULL;

CREATE INDEX "stores_mainCategoryId_idx" ON "stores"("mainCategoryId");

-- RESTRICT: a Category referenced as any store's main category can never be
-- deleted at the DB level either — defense-in-depth alongside the friendly
-- application-level check in categories.service#remove.
ALTER TABLE "stores" ADD CONSTRAINT "stores_mainCategoryId_fkey" FOREIGN KEY ("mainCategoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
