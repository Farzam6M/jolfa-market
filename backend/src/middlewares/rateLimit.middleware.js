const rateLimit = require('express-rate-limit');
const env = require('../config/env');

/** General API limiter — applied globally. */
const apiLimiter = rateLimit({
  windowMs: env.rateLimit.windowMs,
  max: env.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'تعداد درخواست‌ها بیش از حد مجاز است، کمی بعد تلاش کنید' },
});

/** Tighter limiter for auth endpoints (login/register) to slow brute-force. */
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'تعداد تلاش‌های ورود بیش از حد مجاز است' },
});

/**
 * Dedicated limiter for POST /auth/otp/send. Kept separate from
 * authLimiter (above) — that one limiter is shared across login,
 * register, forgot-password AND reset-password, so a burst on any one
 * of those used to also eat into the others' shared quota. Issuing an
 * OTP additionally costs a real SMS, so it gets its own (by default,
 * tighter) budget.
 *
 * Keyed by IP *and* the target mobile number (not just IP): this bounds
 * both directions of abuse — one mobile number being hammered with OTPs
 * from many source ports on a single IP, and a single IP spraying OTP
 * requests across many different mobile numbers — without the two
 * sharing one counter. req.body is available here because express.json()
 * runs globally in app.js before this route is reached, ahead of this
 * route's own validate() call.
 */
const otpLimiter = rateLimit({
  windowMs: env.otp.requestWindowMin * 60 * 1000,
  max: env.otp.requestMaxPerWindow,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${(req.body && req.body.mobile) || ''}`,
  message: { success: false, message: 'تعداد درخواست‌های کد تایید بیش از حد مجاز است، کمی بعد تلاش کنید' },
});

module.exports = { apiLimiter, authLimiter, otpLimiter };
