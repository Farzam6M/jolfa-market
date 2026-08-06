const { prisma } = require('../../config/database');
const env = require('../../config/env');
const ApiError = require('../../utils/ApiError');
const { hashPassword, comparePassword } = require('../../utils/password');
const {
  signAccessToken, signRefreshToken, verifyRefreshToken, hashToken,
  generateSecureToken, generateNumericCode, refreshExpiryMs,
} = require('../../utils/tokens');
const { sendSms, sendEmail } = require('../../utils/messaging');
const { logAdminActivity } = require('../admin/admin.service');
const { pushNotification } = require('../notifications/notifications.service');

function toPublicUser(user) {
  return {
    id: user.id,
    name: user.name,
    mobile: user.mobile,
    email: user.email,
    avatarUrl: user.avatarUrl,
    role: user.role.key,
    status: user.status,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    emailVerified: !!user.emailVerifiedAt,
    mobileVerified: !!user.mobileVerifiedAt,
  };
}

/** Every security-relevant event is appended to the append-only admin activity log, visible only to Admin/Super Admin (enforced at the route layer). */
function logSecurityEvent(actorId, event, label, meta = null) {
  return logAdminActivity(actorId, label, { event, ...(meta || {}) });
}

async function issueTokenPair(user, meta = {}) {
  const accessToken = signAccessToken({ sub: user.id, role: user.role.key });
  const refreshToken = signRefreshToken({ sub: user.id });
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + refreshExpiryMs()),
      userAgent: meta.userAgent || null,
      ip: meta.ip || null,
      lastUsedAt: new Date(),
    },
  });
  return { accessToken, refreshToken };
}

// Client-facing (kebab-case) purpose -> Prisma `OtpPurpose` enum value.
// Mirrors VERIFICATION_TYPE_MAP's convention just below. LOGIN and
// PASSWORD_RESET aren't wired to a flow yet (only REGISTER is, in this
// step) but are mapped now so sendOtp()/verifyAndConsumeOtp() need no
// changes when those flows are added later — only new routes/controller
// actions consuming them.
const OTP_PURPOSE_MAP = { register: 'REGISTER', login: 'LOGIN', 'password-reset': 'PASSWORD_RESET' };

/**
 * Issues (or re-issues, subject to a cooldown) an OTP for the given mobile
 * number + purpose. Mocked delivery — goes through the same `sendSms`
 * choke point as every other SMS in this codebase (see utils/messaging.js).
 *
 * For purpose=register specifically, this also rejects already-registered
 * numbers up front so an SMS is never wasted on a mobile that register()
 * would reject anyway — register() still repeats its own check (defense in
 * depth, and it's the check that actually matters since this one is only a
 * courtesy/early-exit).
 */
async function sendOtp({ mobile, purpose: purposeParam }) {
  const purpose = OTP_PURPOSE_MAP[purposeParam];

  if (purpose === 'REGISTER') {
    const existing = await prisma.user.findUnique({ where: { mobile } });
    if (existing) throw ApiError.conflict('این شماره موبایل قبلاً ثبت شده است');
  }

  const last = await prisma.otpCode.findFirst({
    where: { mobile, purpose },
    orderBy: { createdAt: 'desc' },
  });
  const cooldownMs = env.otp.resendCooldownSec * 1000;
  if (last && Date.now() - last.createdAt.getTime() < cooldownMs) {
    throw ApiError.badRequest('برای ارسال مجدد کد کمی صبر کنید');
  }

  // Invalidate any still-outstanding codes for this (mobile, purpose) before
  // issuing a new one — same "only the latest code is ever valid" rule
  // forgotPassword() applies to password_reset_tokens.
  await prisma.otpCode.updateMany({ where: { mobile, purpose, consumed: false }, data: { consumed: true } });

  const code = generateNumericCode(6);
  await prisma.otpCode.create({
    data: {
      mobile,
      purpose,
      codeHash: hashToken(code),
      maxAttempts: env.otp.maxAttempts,
      expiresAt: new Date(Date.now() + env.otp.expiresMin * 60 * 1000),
    },
  });

  await sendSms(mobile, `کد تأیید شما: ${code}`);
}

/**
 * Verifies an OTP for (mobile, purpose) and atomically consumes it so it
 * can never be reused — same atomic-claim pattern (updateMany + count
 * check) used for password-reset tokens and email/mobile verification
 * codes elsewhere in this file, to guard against a concurrent-request race
 * double-spending one code. Internal helper (not a route by itself) so
 * every future OTP-gated flow (login, password-reset) can call it exactly
 * like register() does below.
 *
 * Wrong-code attempts increment the row's `attempts` counter; once it
 * reaches `maxAttempts` the code is dead even if the correct value is
 * supplied afterwards, and the caller must request a fresh one via sendOtp().
 */
async function verifyAndConsumeOtp(mobile, purposeParam, code) {
  const purpose = OTP_PURPOSE_MAP[purposeParam];
  const invalid = () => ApiError.badRequest('کد تأیید نامعتبر یا منقضی شده است');

  const record = await prisma.otpCode.findFirst({
    where: { mobile, purpose, consumed: false },
    orderBy: { createdAt: 'desc' },
  });
  if (!record) throw invalid();
  if (record.expiresAt < new Date()) throw invalid();
  if (record.attempts >= record.maxAttempts) {
    throw ApiError.badRequest('تعداد تلاش‌های مجاز برای این کد به پایان رسیده است — یک کد جدید درخواست کنید');
  }

  if (record.codeHash !== hashToken(code)) {
    await prisma.otpCode.update({ where: { id: record.id }, data: { attempts: { increment: 1 } } });
    throw invalid();
  }

  const claim = await prisma.otpCode.updateMany({
    where: { id: record.id, consumed: false },
    data: { consumed: true },
  });
  if (claim.count === 0) throw invalid(); // lost a race to another concurrent verify call

  return true;
}

/**
 * New customer self-registration. Sellers/admins are created through
 * dedicated flows (seller application, admin creation).
 *
 * Now OTP-gated: `otpCode` must be a still-valid, unconsumed code
 * previously issued by sendOtp({ purpose: 'register' }) for this exact
 * mobile. It is verified and consumed BEFORE the User row is created — if
 * verification fails, no account is created and none of the post-creation
 * side effects (cart/wallet creation, admin notification, activity log,
 * token issuance) run.
 */
async function register({ name, mobile, password, otpCode }, meta = {}) {
  const existing = await prisma.user.findUnique({ where: { mobile } });
  if (existing) throw ApiError.conflict('این شماره موبایل قبلاً ثبت شده است');

  await verifyAndConsumeOtp(mobile, 'register', otpCode);

  const role = await prisma.role.findUnique({ where: { key: 'CUSTOMER' } });
  if (!role) throw ApiError.internal('نقش پیش‌فرض کاربر یافت نشد — seed را اجرا کنید');

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { name, mobile, passwordHash, roleId: role.id },
    include: { role: true },
  });

  await prisma.cart.create({ data: { userId: user.id } });
  await prisma.wallet.create({ data: { userId: user.id } });

  await pushNotification({
    icon: 'i-users',
    text: `کاربر جدید «${name}» ثبت‌نام کرد`,
    scope: 'ROLE',
    targetRole: 'ADMIN',
  });
  await logAdminActivity(null, `ثبت‌نام کاربر جدید: ${name}`);

  const tokens = await issueTokenPair(user, meta);
  return { user: toPublicUser(user), ...tokens };
}

async function login({ mobile, password }, meta = {}) {
  const user = await prisma.user.findUnique({ where: { mobile }, include: { role: true } });
  const invalidCredentials = () => ApiError.unauthorized('شماره موبایل یا رمز عبور اشتباه است');

  if (!user) throw invalidCredentials();

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw ApiError.forbidden('به دلیل تلاش‌های ناموفق مکرر، حساب موقتاً قفل شده است. کمی بعد دوباره تلاش کنید');
  }

  if (user.status !== 'ACTIVE') throw ApiError.forbidden('حساب کاربری غیرفعال یا مسدود شده است');

  const ok = await comparePassword(password, user.passwordHash);
  if (!ok) {
    const attempts = user.failedLoginCount + 1;
    const shouldLock = attempts >= env.login.maxAttempts;
    await prisma.user.update({
      where: { id: user.id },
      data: shouldLock
        ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + env.login.lockMinutes * 60 * 1000) }
        : { failedLoginCount: attempts },
    });
    await logSecurityEvent(user.id, 'LOGIN_FAILED', `تلاش ناموفق ورود برای «${user.name}»`, { attempts, ip: meta.ip });
    throw invalidCredentials();
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
  });

  const tokens = await issueTokenPair(user, meta);
  await logSecurityEvent(user.id, 'LOGIN_SUCCESS', `ورود موفق «${user.name}»`, { ip: meta.ip, userAgent: meta.userAgent });
  return { user: toPublicUser(user), ...tokens };
}

async function refresh({ refreshToken }, meta = {}) {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch (e) {
    throw ApiError.unauthorized('توکن refresh نامعتبر یا منقضی شده است');
  }

  const tokenHash = hashToken(refreshToken);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!stored) throw ApiError.unauthorized('توکن refresh نامعتبر یا منقضی شده است');

  if (stored.revoked) {
    // A previously-rotated/revoked token being replayed is a strong signal of theft.
    // Kill every session for this user rather than trusting this token further.
    await prisma.refreshToken.updateMany({ where: { userId: stored.userId }, data: { revoked: true } });
    await logSecurityEvent(stored.userId, 'REFRESH_TOKEN_REUSE_DETECTED', 'شناسایی استفاده مجدد از refresh token — همه نشست‌ها باطل شدند', { ip: meta.ip });
    throw ApiError.unauthorized('توکن refresh نامعتبر یا منقضی شده است');
  }

  if (stored.expiresAt < new Date()) {
    throw ApiError.unauthorized('توکن refresh نامعتبر یا منقضی شده است');
  }

  const user = await prisma.user.findUnique({ where: { id: payload.sub }, include: { role: true } });
  if (!user || user.status !== 'ACTIVE') throw ApiError.unauthorized('کاربر یافت نشد یا غیرفعال است');

  // Atomic claim: only one concurrent refresh request for the same token can
  // actually flip it to revoked. Without this, two near-simultaneous refresh
  // calls (e.g. two tabs, or a client retry) could both read revoked:false
  // and both rotate — minting two valid token pairs from a single-use token
  // instead of the second one hitting reuse-detection like it should.
  const claim = await prisma.refreshToken.updateMany({
    where: { id: stored.id, revoked: false },
    data: { revoked: true, lastUsedAt: new Date() },
  });
  if (claim.count === 0) {
    await prisma.refreshToken.updateMany({ where: { userId: stored.userId }, data: { revoked: true } });
    await logSecurityEvent(stored.userId, 'REFRESH_TOKEN_REUSE_DETECTED', 'شناسایی استفاده مجدد از refresh token — همه نشست‌ها باطل شدند', { ip: meta.ip });
    throw ApiError.unauthorized('توکن refresh نامعتبر یا منقضی شده است');
  }
  const tokens = await issueTokenPair(user, meta);
  return { user: toPublicUser(user), ...tokens };
}

/** Re-fetches the current user from the database and returns it in the same public shape as login/register/refresh. */
async function getMe(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
  if (!user) throw ApiError.notFound('کاربر یافت نشد');
  return toPublicUser(user);
}

async function logout({ refreshToken }) {
  if (!refreshToken) return;
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(refreshToken) },
    data: { revoked: true },
  });
}

/**
 * Changes the current user's password. Invalidates every refresh token
 * (i.e. every session) belonging to the user, unless the caller supplies
 * its own current refreshToken, in which case that one session survives.
 */
async function changePassword(userId, { currentPassword, newPassword, refreshToken }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.notFound('کاربر یافت نشد');

  const ok = await comparePassword(currentPassword, user.passwordHash);
  if (!ok) throw ApiError.unauthorized('رمز عبور فعلی صحیح نیست');

  const isSameAsCurrent = await comparePassword(newPassword, user.passwordHash);
  if (isSameAsCurrent) throw ApiError.badRequest('رمز عبور جدید نباید با رمز عبور فعلی یکسان باشد');

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });

  const keepTokenHash = refreshToken ? hashToken(refreshToken) : null;
  await prisma.refreshToken.updateMany({
    where: { userId, ...(keepTokenHash ? { tokenHash: { not: keepTokenHash } } : {}) },
    data: { revoked: true },
  });

  await logSecurityEvent(userId, 'CHANGE_PASSWORD', `تغییر رمز عبور «${user.name}»`, { keptCurrentSession: !!keepTokenHash });
}

/**
 * Starts password recovery. Never reveals whether the mobile number is
 * registered (anti-enumeration) — the controller always returns the same
 * generic message regardless of what this function does internally.
 */
async function forgotPassword({ mobile }) {
  const user = await prisma.user.findUnique({ where: { mobile } });
  if (!user) return; // silently no-op — avoids leaking account existence

  // Invalidate any still-outstanding reset tokens before issuing a new one.
  await prisma.passwordResetToken.updateMany({ where: { userId: user.id, used: false }, data: { used: true } });

  const rawToken = generateSecureToken();
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + env.passwordReset.expiresMin * 60 * 1000),
    },
  });

  await sendSms(user.mobile, `کد/لینک بازیابی رمز عبور شما: ${rawToken}`);
  await logSecurityEvent(user.id, 'FORGOT_PASSWORD_REQUEST', `درخواست بازیابی رمز عبور «${user.name}»`);
}

/** Consumes a password-reset token exactly once (atomic claim guards against race conditions on concurrent requests). */
async function resetPassword({ token, newPassword }) {
  const tokenHash = hashToken(token);
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });
  if (!record || record.used || record.expiresAt < new Date()) {
    throw ApiError.badRequest('توکن بازیابی نامعتبر یا منقضی شده است');
  }

  // Atomically claim the token — updateMany's count tells us if we won the race.
  const claim = await prisma.passwordResetToken.updateMany({
    where: { id: record.id, used: false },
    data: { used: true },
  });
  if (claim.count === 0) throw ApiError.badRequest('توکن بازیابی نامعتبر یا منقضی شده است');

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: record.userId }, data: { passwordHash } });
  await prisma.refreshToken.updateMany({ where: { userId: record.userId }, data: { revoked: true } });

  await logSecurityEvent(record.userId, 'RESET_PASSWORD', 'بازیابی رمز عبور با موفقیت انجام شد');
}

const VERIFICATION_TYPE_MAP = { email: 'EMAIL', mobile: 'MOBILE' };

/** Sends (or re-sends, subject to a cooldown) a verification code for the user's own email or mobile. Mocked — swap `messaging.js` for a real provider. */
async function sendVerification(userId, typeParam) {
  const type = VERIFICATION_TYPE_MAP[typeParam];
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.notFound('کاربر یافت نشد');

  const target = type === 'EMAIL' ? user.email : user.mobile;
  if (type === 'EMAIL' && !target) throw ApiError.badRequest('ابتدا یک ایمیل برای حساب خود ثبت کنید');
  if (type === 'EMAIL' && user.emailVerifiedAt) throw ApiError.badRequest('ایمیل قبلاً تأیید شده است');
  if (type === 'MOBILE' && user.mobileVerifiedAt) throw ApiError.badRequest('شماره موبایل قبلاً تأیید شده است');

  const last = await prisma.verificationToken.findFirst({
    where: { userId, type },
    orderBy: { createdAt: 'desc' },
  });
  const cooldownMs = env.verification.resendCooldownSec * 1000;
  if (last && Date.now() - last.createdAt.getTime() < cooldownMs) {
    throw ApiError.badRequest('برای ارسال مجدد کد کمی صبر کنید');
  }

  await prisma.verificationToken.updateMany({ where: { userId, type, used: false }, data: { used: true } });

  const code = generateNumericCode(6);
  await prisma.verificationToken.create({
    data: {
      userId,
      type,
      target,
      tokenHash: hashToken(code),
      expiresAt: new Date(Date.now() + env.verification.expiresMin * 60 * 1000),
    },
  });

  if (type === 'EMAIL') await sendEmail(target, 'کد تأیید ایمیل', `کد تأیید شما: ${code}`);
  else await sendSms(target, `کد تأیید شما: ${code}`);
}

/** Confirms a verification code exactly once (atomic claim, same race-condition guard as password reset). */
async function confirmVerification(userId, typeParam, code) {
  const type = VERIFICATION_TYPE_MAP[typeParam];
  const tokenHash = hashToken(code);
  const record = await prisma.verificationToken.findFirst({ where: { userId, type, tokenHash } });
  if (!record || record.used || record.expiresAt < new Date()) {
    throw ApiError.badRequest('کد تأیید نامعتبر یا منقضی شده است');
  }

  const claim = await prisma.verificationToken.updateMany({
    where: { id: record.id, used: false },
    data: { used: true },
  });
  if (claim.count === 0) throw ApiError.badRequest('کد تأیید نامعتبر یا منقضی شده است');

  await prisma.user.update({
    where: { id: userId },
    data: type === 'EMAIL' ? { emailVerifiedAt: new Date() } : { mobileVerifiedAt: new Date() },
  });

  await logSecurityEvent(userId, `VERIFY_${type}`, `تأیید ${type === 'EMAIL' ? 'ایمیل' : 'موبایل'} با موفقیت انجام شد`);
}

/** Lists this user's active sessions (each is one refresh token). `isCurrent` is best-effort, matched against an optional current refresh token supplied by the client. */
async function listSessions(userId, currentRefreshToken) {
  const currentHash = currentRefreshToken ? hashToken(currentRefreshToken) : null;
  const sessions = await prisma.refreshToken.findMany({
    where: { userId, revoked: false, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: 'desc' },
  });
  return sessions.map((s) => ({
    id: s.id,
    device: s.userAgent || 'نامشخص',
    ip: s.ip || 'نامشخص',
    createdAt: s.createdAt,
    lastActivityAt: s.lastUsedAt || s.createdAt,
    isCurrent: !!currentHash && currentHash === s.tokenHash,
  }));
}

async function revokeSession(userId, sessionId) {
  const session = await prisma.refreshToken.findUnique({ where: { id: sessionId } });
  if (!session || session.userId !== userId) throw ApiError.notFound('نشست یافت نشد');
  await prisma.refreshToken.update({ where: { id: sessionId }, data: { revoked: true } });
  await logSecurityEvent(userId, 'SESSION_REVOKED', 'خروج از یک نشست فعال');
}

/** Revokes all sessions, optionally keeping the caller's own current one alive. */
async function revokeAllSessions(userId, currentRefreshToken) {
  const currentHash = currentRefreshToken ? hashToken(currentRefreshToken) : null;
  await prisma.refreshToken.updateMany({
    where: { userId, ...(currentHash ? { tokenHash: { not: currentHash } } : {}) },
    data: { revoked: true },
  });
  await logSecurityEvent(userId, 'ALL_SESSIONS_REVOKED', 'خروج از همه نشست‌های فعال', { keptCurrentSession: !!currentHash });
}

module.exports = {
  register,
  login,
  refresh,
  logout,
  getMe,
  changePassword,
  forgotPassword,
  resetPassword,
  sendVerification,
  confirmVerification,
  sendOtp,
  listSessions,
  revokeSession,
  revokeAllSessions,
  toPublicUser,
};
