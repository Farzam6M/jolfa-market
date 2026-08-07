const jwt = require('jsonwebtoken');
const ms = require('ms');
const crypto = require('crypto');
const env = require('../config/env');

/**
 * Milliseconds equivalent of env.jwt.refreshExpiresIn (e.g. "30d"), so the
 * RefreshToken row's `expiresAt` always matches the lifetime actually signed
 * into the JWT itself instead of a separately hardcoded constant.
 */
function refreshExpiryMs() {
  return ms(env.jwt.refreshExpiresIn);
}

function signAccessToken(payload) {
  return jwt.sign(payload, env.jwt.accessSecret, { expiresIn: env.jwt.accessExpiresIn });
}

function signRefreshToken(payload) {
  return jwt.sign(payload, env.jwt.refreshSecret, { expiresIn: env.jwt.refreshExpiresIn });
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.jwt.accessSecret);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwt.refreshSecret);
}

/** Refresh tokens are stored hashed (never plaintext) so a DB leak can't be replayed. */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * HMAC key for hashOtpCode() below. Prefers a dedicated OTP_HASH_SECRET
 * (env.otp.hashSecret) so it can be rotated independently of the JWT
 * secrets; falls back to combining the two JWT secrets (both already
 * `requiredSecret()`-enforced at startup) so existing deployments that
 * haven't set OTP_HASH_SECRET yet keep working without a forced env
 * change, while the key is still unique to this deployment.
 */
function otpHashKey() {
  return env.otp.hashSecret || `${env.jwt.accessSecret}:${env.jwt.refreshSecret}`;
}

/**
 * Hashes an OTP code for storage (otp_codes.codeHash). Unlike hashToken()
 * above — fine for the high-entropy, random refresh/reset tokens it
 * protects — a 6-digit OTP only has ~1,000,000 possible values, so a
 * plain unsalted SHA-256 hash of it is trivially reversible via a
 * precomputed table if the otp_codes table ever leaks. This is keyed
 * (HMAC, never derivable without the server secret) and bound to
 * (mobile, purpose) so the same code never hashes identically for two
 * different numbers/purposes.
 */
function hashOtpCode(mobile, purpose, code) {
  return crypto.createHmac('sha256', otpHashKey()).update(`${mobile}:${purpose}:${code}`).digest('hex');
}

/** Cryptographically-random opaque token (password reset links, etc). Only the hash is persisted. */
function generateSecureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Short numeric OTP-style code, convenient for SMS/email verification. Only the hash is persisted. */
function generateNumericCode(length = 6) {
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += crypto.randomInt(0, 10).toString();
  }
  return code;
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashToken,
  hashOtpCode,
  generateSecureToken,
  generateNumericCode,
  refreshExpiryMs,
};
