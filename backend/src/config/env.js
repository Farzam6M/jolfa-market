require('dotenv').config();

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Secrets must never silently fall back to a value that also lives in source
// control (e.g. a "dev_..._secret" default) — that value is public knowledge
// the moment the repo is, so a missing env var in production would otherwise
// leave tokens signable/forgeable by anyone who has read the code.
function requiredSecret(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required secret env var: ${name} (no default is allowed for secrets)`);
  return v;
}

// CORS origins must be explicit and never fall back to "*". A wildcard origin
// combined with `credentials: true` (needed for the Authorization header /
// refresh-token flow) is both rejected by browsers and unsafe in principle —
// so a missing or wildcard CORS_ORIGIN must fail the app at startup with a
// clear message instead of silently allowing every origin.
function requiredCorsOrigins(name) {
  const raw = process.env[name];
  if (!raw) {
    throw new Error(
      `Missing required env var: ${name} (comma-separated list of allowed frontend origins, ` +
      `e.g. "https://example.com,https://admin.example.com" — no "*" fallback is allowed)`
    );
  }
  const origins = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (origins.length === 0 || origins.includes('*')) {
    throw new Error(
      `${name} must be an explicit, comma-separated list of origins — "*" is not allowed ` +
      `because it is incompatible with credentialed requests (cookies/Authorization headers)`
    );
  }
  return origins;
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '4000', 10),
  apiPrefix: process.env.API_PREFIX || '/api/v1',
  corsOrigins: requiredCorsOrigins('CORS_ORIGIN'),

  jwt: {
    accessSecret: requiredSecret('JWT_ACCESS_SECRET'),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshSecret: requiredSecret('JWT_REFRESH_SECRET'),
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10),

  upload: {
    dir: process.env.UPLOAD_DIR || 'uploads',
    maxMb: parseInt(process.env.MAX_UPLOAD_MB || '5', 10),
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX || '300', 10),
  },

  login: {
    maxAttempts: parseInt(process.env.LOGIN_MAX_ATTEMPTS || '5', 10),
    lockMinutes: parseInt(process.env.LOGIN_LOCK_MINUTES || '15', 10),
  },

  passwordReset: {
    expiresMin: parseInt(process.env.RESET_TOKEN_EXPIRES_MIN || '30', 10),
  },

  verification: {
    expiresMin: parseInt(process.env.VERIFICATION_TOKEN_EXPIRES_MIN || '15', 10),
    resendCooldownSec: parseInt(process.env.VERIFICATION_RESEND_COOLDOWN_SEC || '60', 10),
  },

  // OTP codes (registration, and — reusing the same otp_codes table/purpose
  // enum — future login-by-OTP and OTP password-reset). Same shape as
  // `verification` above on purpose, since the semantics (expiry + resend
  // cooldown) are identical; `maxAttempts` additionally bounds brute-force
  // guesses against a single issued code.
  otp: {
    expiresMin: parseInt(process.env.OTP_CODE_EXPIRES_MIN || '5', 10),
    maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS || '5', 10),
    resendCooldownSec: parseInt(process.env.OTP_RESEND_COOLDOWN_SEC || '60', 10),
    // Dedicated rate limit for POST /auth/otp/send (see otpLimiter in
    // rateLimit.middleware.js) — deliberately separate from the shared
    // authLimiter (login/register/forgot-password/reset-password) so
    // exhausting one never blocks the other, and tighter by default
    // since issuing an OTP costs a real SMS.
    requestWindowMin: parseInt(process.env.OTP_REQUEST_WINDOW_MIN || '10', 10),
    requestMaxPerWindow: parseInt(process.env.OTP_REQUEST_MAX_PER_WINDOW || '5', 10),
    // Optional dedicated secret for hashing OTP codes at rest (see
    // utils/tokens.js hashOtpCode()). Deliberately NOT a requiredSecret()
    // — unset falls back to deriving an equivalent HMAC key from the JWT
    // secrets (see otpHashKey() in tokens.js) so existing deployments
    // keep working without a forced env change. Set this explicitly in
    // production if you want OTP hashing rotatable independently of the
    // JWT secrets.
    hashSecret: process.env.OTP_HASH_SECRET || null,
  },

  // HMAC secret shared with the payment gateway to sign its callback/webhook
  // payload. Deliberately NOT a requiredSecret() — no gateway provider is
  // wired in yet, so this stays undefined in dev. The callback route itself
  // fails closed (rejects every request) when it's unset, rather than
  // silently accepting unsigned callbacks. Swap the signing scheme in
  // gateway.middleware.js for the actual provider's mechanism once one is
  // chosen (this HMAC layer is a generic, vendor-agnostic placeholder).
  gateway: {
    callbackSecret: process.env.GATEWAY_CALLBACK_SECRET || null,
  },
};
