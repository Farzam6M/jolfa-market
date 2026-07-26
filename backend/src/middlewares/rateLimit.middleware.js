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

module.exports = { apiLimiter, authLimiter };
