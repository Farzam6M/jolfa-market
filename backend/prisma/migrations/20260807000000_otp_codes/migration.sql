-- Adds infrastructure for OTP-based flows (registration, login,
-- password-reset) via a new `otp_codes` table.
--
-- Deliberately NOT tied to the `users` table (no userId / foreign key):
-- unlike verification_tokens (which verifies an ALREADY-EXISTING account's
-- email/mobile), OTP registration happens BEFORE any User row exists, so
-- there is nothing to reference yet. OTP login and OTP password-reset also
-- key off `mobile` directly and resolve the user in application code,
-- matching the existing plain-string convention already used elsewhere in
-- this schema for cases that intentionally skip a relation (e.g.
-- User.deletedById).
--
-- This migration is purely additive — no existing table or column is
-- touched, so every current flow (login, register, seller, admin panel...)
-- is unaffected.

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('REGISTER', 'LOGIN', 'PASSWORD_RESET');

-- CreateTable
CREATE TABLE "otp_codes" (
    "id" TEXT NOT NULL,
    "mobile" TEXT NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "otp_codes_mobile_purpose_idx" ON "otp_codes"("mobile", "purpose");
