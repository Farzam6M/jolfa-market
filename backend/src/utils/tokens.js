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
  generateSecureToken,
  generateNumericCode,
  refreshExpiryMs,
};
