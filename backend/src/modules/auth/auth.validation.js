const { z } = require('zod');

const mobileSchema = z.string().regex(/^09\d{9}$/, 'شماره موبایل باید با 09 شروع و 11 رقم باشد');

// Applied everywhere a *new* password is set (register, change-password,
// reset-password) — NOT on login, where the plaintext just needs to be sent
// as-is for comparison against the stored hash, whatever its shape.
const strongPasswordSchema = z
  .string()
  .min(8, 'رمز عبور باید حداقل ۸ کاراکتر باشد')
  .regex(/[a-z]/, 'رمز عبور باید حداقل شامل یک حرف کوچک انگلیسی باشد')
  .regex(/[A-Z]/, 'رمز عبور باید حداقل شامل یک حرف بزرگ انگلیسی باشد')
  .regex(/[0-9]/, 'رمز عبور باید حداقل شامل یک عدد باشد');

// Same purpose set as the Prisma `OtpPurpose` enum, spelled the way a client
// would send it in a request body/URL (kebab-case), mapped to the Prisma
// enum's UPPER_SNAKE_CASE inside auth.service.js — matches the existing
// verificationTypeParamSchema convention just below.
const otpPurposeSchema = z.enum(['register', 'login', 'password-reset'], {
  errorMap: () => ({ message: 'هدف OTP باید یکی از register، login یا password-reset باشد' }),
});

const sendOtpSchema = z.object({
  mobile: mobileSchema,
  purpose: otpPurposeSchema,
});

const registerSchema = z.object({
  name: z.string().min(2, 'نام باید حداقل ۲ کاراکتر باشد').max(80),
  mobile: mobileSchema,
  password: strongPasswordSchema,
  // Must be a previously-issued, still-valid OTP for this mobile with
  // purpose=register (see POST /auth/otp/send) — verified and consumed
  // inside authService.register() before the User row is created.
  otpCode: z.string().min(4, 'کد تأیید نامعتبر است').max(10),
});

const loginSchema = z.object({
  mobile: mobileSchema,
  password: z.string().min(1, 'رمز عبور الزامی است'),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'رمز عبور فعلی الزامی است'),
  newPassword: strongPasswordSchema,
  confirmNewPassword: z.string().min(1, 'تکرار رمز عبور جدید الزامی است'),
  // Optional: if the client sends its own current refresh token, that one
  // session is kept alive; every other session is revoked. Omit to log out everywhere.
  refreshToken: z.string().min(10).optional(),
}).refine((data) => data.newPassword === data.confirmNewPassword, {
  message: 'رمز عبور جدید و تکرار آن یکسان نیستند',
  path: ['confirmNewPassword'],
});

const forgotPasswordSchema = z.object({
  mobile: mobileSchema,
});

const resetPasswordSchema = z.object({
  token: z.string().min(10, 'توکن بازیابی نامعتبر است'),
  newPassword: strongPasswordSchema,
  confirmNewPassword: z.string().min(1, 'تکرار رمز عبور جدید الزامی است'),
}).refine((data) => data.newPassword === data.confirmNewPassword, {
  message: 'رمز عبور جدید و تکرار آن یکسان نیستند',
  path: ['confirmNewPassword'],
});

const verificationTypeParamSchema = z.object({
  type: z.enum(['email', 'mobile'], { errorMap: () => ({ message: 'نوع تأیید باید email یا mobile باشد' }) }),
});

const verifyConfirmSchema = z.object({
  code: z.string().min(4, 'کد تأیید نامعتبر است').max(10),
});

const sessionIdParamSchema = z.object({
  id: z.string().uuid('شناسه نشست نامعتبر است'),
});

module.exports = {
  registerSchema,
  loginSchema,
  refreshSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verificationTypeParamSchema,
  verifyConfirmSchema,
  sessionIdParamSchema,
  otpPurposeSchema,
  sendOtpSchema,
};
