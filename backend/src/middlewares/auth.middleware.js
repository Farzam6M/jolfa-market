const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { verifyAccessToken } = require('../utils/tokens');
const { prisma } = require('../config/database');
const { ROLE_PERMISSIONS } = require('../modules/roles/permissions.constants');

/**
 * Verifies the Bearer access token, loads the current user (with role),
 * and attaches `req.user` = { id, mobile, roleKey, permissions }.
 * Rejects suspended/banned accounts even if the token is still valid.
 */
const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    throw ApiError.unauthorized('توکن احراز هویت ارسال نشده است');
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    throw ApiError.unauthorized('توکن نامعتبر یا منقضی شده است');
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    include: { role: true },
  });
  if (!user) throw ApiError.unauthorized('کاربر یافت نشد');
  if (user.status !== 'ACTIVE') throw ApiError.forbidden('حساب کاربری غیرفعال یا مسدود شده است');

  const roleKey = user.role.key;
  const permissions = ROLE_PERMISSIONS[roleKey] || [];

  req.user = {
    id: user.id,
    name: user.name,
    mobile: user.mobile,
    roleKey,
    permissions,
  };
  next();
});

/** Populates req.user if a valid token is present, but never rejects. Useful for public+personalized routes (e.g. product listing that also flags wishlist state). */
const optionalAuthenticate = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return next();
  try {
    const payload = verifyAccessToken(token);
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, include: { role: true } });
    if (user && user.status === 'ACTIVE') {
      req.user = {
        id: user.id,
        name: user.name,
        mobile: user.mobile,
        roleKey: user.role.key,
        permissions: ROLE_PERMISSIONS[user.role.key] || [],
      };
    }
  } catch (e) { /* ignore invalid token on optional routes */ }
  next();
});

module.exports = { authenticate, optionalAuthenticate };
