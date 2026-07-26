const ApiError = require('../utils/ApiError');

/**
 * Requires the authenticated user's role to include ALL given permissions
 * (or the SUPER_ADMIN wildcard '*'). Use after `authenticate`.
 *   router.post('/products', authenticate, requirePermission(PERMISSIONS.PRODUCTS_CREATE_OWN), ctrl.create)
 */
function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    const has = req.user.permissions.includes('*')
      || permissions.every((p) => req.user.permissions.includes(p));
    if (!has) return next(ApiError.forbidden('نقش شما به این عملیات دسترسی ندارد'));
    next();
  };
}

/**
 * Requires the authenticated user's role to include AT LEAST ONE of the
 * given permissions (or the SUPER_ADMIN wildcard '*'). Use when a route is
 * reachable through more than one permission grant (e.g. an admin's
 * unrestricted permission vs. a seller's scoped-to-own-store permission) —
 * the fine-grained scoping for the narrower permission is then enforced in
 * the service layer, not here.
 */
function requireAnyPermission(...permissions) {
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    const has = req.user.permissions.includes('*')
      || permissions.some((p) => req.user.permissions.includes(p));
    if (!has) return next(ApiError.forbidden('نقش شما به این عملیات دسترسی ندارد'));
    next();
  };
}

/** Requires the user's role key to be one of the given roles. */
function requireRole(...roleKeys) {
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!roleKeys.includes(req.user.roleKey)) {
      return next(ApiError.forbidden('نقش شما به این عملیات دسترسی ندارد'));
    }
    next();
  };
}

/**
 * Ownership guard: fetches a resource's owner id via `getOwnerId(req)` and
 * allows the request through if req.user.id matches it OR the user holds
 * `overridePermission` (e.g. an admin bypass). Prevents users from reading
 * or mutating data that isn't theirs even if they guess another id in the URL.
 */
function requireOwnerOr(overridePermission, getOwnerId) {
  return async (req, res, next) => {
    try {
      if (!req.user) return next(ApiError.unauthorized());
      if (req.user.permissions.includes('*') || req.user.permissions.includes(overridePermission)) {
        return next();
      }
      const ownerId = await getOwnerId(req);
      if (ownerId && ownerId === req.user.id) return next();
      return next(ApiError.forbidden('دسترسی به این منبع مجاز نیست'));
    } catch (err) { next(err); }
  };
}

module.exports = {
  requirePermission, requireAnyPermission, requireRole, requireOwnerOr,
};
