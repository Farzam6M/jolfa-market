const router = require('express').Router();
const controller = require('./auth.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { authLimiter, otpLimiter } = require('../../middlewares/rateLimit.middleware');
const {
  registerSchema, loginSchema, refreshSchema, changePasswordSchema,
  forgotPasswordSchema, resetPasswordSchema,
  verificationTypeParamSchema, verifyConfirmSchema, sessionIdParamSchema,
  sendOtpSchema,
} = require('./auth.validation');

// Issues an OTP for a given (mobile, purpose). Currently only purpose=register
// is consumed anywhere (by POST /register below); purpose=login and
// purpose=password-reset are accepted by validation already so this same
// endpoint can back those flows later without changes here.
router.post('/otp/send', otpLimiter, validate({ body: sendOtpSchema }), controller.sendOtp);

router.post('/register', authLimiter, validate({ body: registerSchema }), controller.register);
router.post('/login', authLimiter, validate({ body: loginSchema }), controller.login);
router.post('/refresh', validate({ body: refreshSchema }), controller.refresh);
router.post('/logout', controller.logout);
router.get('/me', authenticate, controller.me);

router.post('/change-password', authenticate, validate({ body: changePasswordSchema }), controller.changePassword);
router.post('/forgot-password', authLimiter, validate({ body: forgotPasswordSchema }), controller.forgotPassword);
router.post('/reset-password', authLimiter, validate({ body: resetPasswordSchema }), controller.resetPassword);

router.post(
  '/verification/:type/send',
  authenticate,
  authLimiter,
  validate({ params: verificationTypeParamSchema }),
  controller.sendVerification,
);
router.post(
  '/verification/:type/confirm',
  authenticate,
  validate({ params: verificationTypeParamSchema, body: verifyConfirmSchema }),
  controller.confirmVerification,
);

router.get('/sessions', authenticate, controller.listSessions);
router.delete('/sessions/:id', authenticate, validate({ params: sessionIdParamSchema }), controller.revokeSession);
router.post('/sessions/revoke-all', authenticate, controller.revokeAllSessions);

module.exports = router;
