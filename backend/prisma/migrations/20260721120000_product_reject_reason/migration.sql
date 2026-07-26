-- Persist the admin's rejection note on the product itself, so it survives
-- past the one-off notification pushed at moderation time and can be shown
-- back to the seller (and in the admin panel) on every subsequent fetch.
ALTER TABLE "products" ADD COLUMN "rejectReason" TEXT;
