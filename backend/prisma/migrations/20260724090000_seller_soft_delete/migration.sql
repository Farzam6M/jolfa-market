-- Seller deletion (DELETE /api/admin/sellers/:sellerId) never SQL-DELETEs the
-- User row: a seller's Store/Product rows can carry order history (OrderItem
-- has no cascading FK back to Product), so removing them for real would either
-- corrupt past orders or fail outright with a foreign-key violation — the same
-- reason products.service.js remove() already refuses to hard-delete a product
-- that appears in any order. Deletion is therefore a controlled soft-delete:
-- the account is banned (existing `status` enum, already blocks login via
-- auth.middleware.js) and stamped with when/by whom for audit + idempotency.
ALTER TABLE "users" ADD COLUMN "deletedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "deletedById" TEXT;
