const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const authService = require('./auth.service');

/** Best-effort client metadata for session/device tracking and audit logs. */
function requestMeta(req) {
  return {
    ip: req.ip,
    userAgent: req.headers['user-agent'] || null,
  };
}

const register = asyncHandler(async (req, res) => {
  const result = await authService.register(req.body, requestMeta(req));
  res.status(201).json(new ApiResponse(result, 'ثبت‌نام با موفقیت انجام شد'));
});

const login = asyncHandler(async (req, res) => {
  const result = await authService.login(req.body, requestMeta(req));
  res.json(new ApiResponse(result, 'ورود موفقیت‌آمیز بود'));
});

const refresh = asyncHandler(async (req, res) => {
  const result = await authService.refresh(req.body, requestMeta(req));
  res.json(new ApiResponse(result, 'توکن با موفقیت تمدید شد'));
});

const logout = asyncHandler(async (req, res) => {
  await authService.logout(req.body);
  res.json(new ApiResponse(null, 'خروج با موفقیت انجام شد'));
});

const me = asyncHandler(async (req, res) => {
  const result = await authService.getMe(req.user.id);
  res.json(new ApiResponse(result, 'اطلاعات کاربر جاری'));
});

const changePassword = asyncHandler(async (req, res) => {
  await authService.changePassword(req.user.id, req.body);
  res.json(new ApiResponse(null, 'رمز عبور با موفقیت تغییر کرد'));
});

const forgotPassword = asyncHandler(async (req, res) => {
  await authService.forgotPassword(req.body);
  // Same response whether or not the mobile number exists — prevents account enumeration.
  res.json(new ApiResponse(null, 'در صورت وجود حساب کاربری با این شماره، کد بازیابی ارسال شد'));
});

const resetPassword = asyncHandler(async (req, res) => {
  await authService.resetPassword(req.body);
  res.json(new ApiResponse(null, 'رمز عبور با موفقیت بازیابی شد'));
});

const verifyResetToken = asyncHandler(async (req, res) => {
  await authService.verifyResetToken(req.body);
  res.json(new ApiResponse(null, 'توکن بازیابی معتبر است'));
});

const sendOtp = asyncHandler(async (req, res) => {
  await authService.sendOtp(req.body);
  res.json(new ApiResponse(null, 'کد تأیید ارسال شد'));
});

const sendVerification = asyncHandler(async (req, res) => {
  await authService.sendVerification(req.user.id, req.params.type);
  res.json(new ApiResponse(null, 'کد تأیید ارسال شد'));
});

const confirmVerification = asyncHandler(async (req, res) => {
  await authService.confirmVerification(req.user.id, req.params.type, req.body.code);
  res.json(new ApiResponse(null, 'تأیید با موفقیت انجام شد'));
});

const listSessions = asyncHandler(async (req, res) => {
  const currentRefreshToken = req.headers['x-refresh-token'];
  res.json(new ApiResponse(await authService.listSessions(req.user.id, currentRefreshToken)));
});

const revokeSession = asyncHandler(async (req, res) => {
  await authService.revokeSession(req.user.id, req.params.id);
  res.json(new ApiResponse(null, 'نشست انتخاب‌شده غیرفعال شد'));
});

const revokeAllSessions = asyncHandler(async (req, res) => {
  const currentRefreshToken = req.headers['x-refresh-token'];
  await authService.revokeAllSessions(req.user.id, currentRefreshToken);
  res.json(new ApiResponse(null, 'همه نشست‌های فعال غیرفعال شدند'));
});

module.exports = {
  register,
  login,
  refresh,
  logout,
  me,
  changePassword,
  forgotPassword,
  resetPassword,
  verifyResetToken,
  sendVerification,
  confirmVerification,
  sendOtp,
  listSessions,
  revokeSession,
  revokeAllSessions,
};
