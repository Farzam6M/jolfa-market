/*
  Warnings:

  - You are about to drop the column `mainCategoryId` on the `stores` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "stores" DROP CONSTRAINT "stores_mainCategoryId_fkey";

-- DropIndex
DROP INDEX "stores_mainCategoryId_idx";

-- AlterTable
ALTER TABLE "stores" DROP COLUMN "mainCategoryId";

-- CreateIndex
CREATE INDEX "order_items_storeProductId_idx" ON "order_items"("storeProductId");

-- RenameForeignKey
ALTER TABLE "cart_items" RENAME CONSTRAINT "cart_items_productId_fkey" TO "cart_items_storeProductId_fkey";

-- RenameForeignKey
ALTER TABLE "order_items" RENAME CONSTRAINT "order_items_productId_fkey" TO "order_items_storeProductId_fkey";

-- RenameForeignKey
ALTER TABLE "product_images" RENAME CONSTRAINT "product_images_productId_fkey" TO "product_images_storeProductId_fkey";

-- RenameForeignKey
ALTER TABLE "store_products" RENAME CONSTRAINT "products_storeId_fkey" TO "store_products_storeId_fkey";

-- RenameForeignKey
ALTER TABLE "wholesale_tiers" RENAME CONSTRAINT "wholesale_tiers_productId_fkey" TO "wholesale_tiers_storeProductId_fkey";

-- RenameForeignKey
ALTER TABLE "wishlist_items" RENAME CONSTRAINT "wishlist_items_productId_fkey" TO "wishlist_items_storeProductId_fkey";

-- RenameIndex
ALTER INDEX "products_status_idx" RENAME TO "store_products_status_idx";

-- RenameIndex
ALTER INDEX "products_status_isActive_idx" RENAME TO "store_products_status_isActive_idx";

-- RenameIndex
ALTER INDEX "products_storeId_idx" RENAME TO "store_products_storeId_idx";
