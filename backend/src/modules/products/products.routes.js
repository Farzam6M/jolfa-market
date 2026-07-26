const router = require('express').Router();
const controller = require('./products.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate, optionalAuthenticate } = require('../../middlewares/auth.middleware');
const { requirePermission, requireAnyPermission, requireOwnerOr } = require('../../middlewares/rbac.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const service = require('./products.service');
const upload = require('../../middlewares/upload.middleware');
const {
  createSchema, updateSchema, moderateSchema, statusAliasSchema, listQuerySchema, stockSchema, activeSchema, addImageSchema,
} = require('./products.validation');

router.get('/', optionalAuthenticate, validate({ query: listQuerySchema }), controller.list); // public
router.get('/:id', optionalAuthenticate, controller.getById); // public

// A staff member (PRODUCTS_MODERATE, e.g. admin/super_admin) can also create a
// product directly — see products.service#create for the storeId handling.
// FIX: this used to be requirePermission(PRODUCTS_CREATE_OWN) only, which
// silently locked the admin role out of product creation entirely (the ADMIN
// role never held PRODUCTS_CREATE_OWN in permissions.constants.js).
router.post(
  '/',
  authenticate,
  requireAnyPermission(PERMISSIONS.PRODUCTS_CREATE_OWN, PERMISSIONS.PRODUCTS_MODERATE),
  validate({ body: createSchema }),
  controller.create,
);

// FIX: requirePermission(PRODUCTS_UPDATE_OWN) below used to gate on the
// SELLER-scoped permission alone, before requireOwnerOr ever ran — so an
// admin (who only holds PRODUCTS_MODERATE, not PRODUCTS_UPDATE_OWN) was
// rejected with 403 here and never reached the "admin override" check.
// tests/stores-products.access.test.js ("admin has full access: can edit ANY
// product" / "...can delete ANY product") already assert the intended
// behavior; requireAnyPermission is what actually satisfies it.
router.patch(
  '/:id',
  authenticate,
  requireAnyPermission(PERMISSIONS.PRODUCTS_UPDATE_OWN, PERMISSIONS.PRODUCTS_MODERATE),
  requireOwnerOr(PERMISSIONS.PRODUCTS_MODERATE, (req) => service.getOwnerUserId(req.params.id)),
  validate({ body: updateSchema }),
  controller.update,
);

router.delete(
  '/:id',
  authenticate,
  requireAnyPermission(PERMISSIONS.PRODUCTS_DELETE_OWN, PERMISSIONS.PRODUCTS_MODERATE),
  requireOwnerOr(PERMISSIONS.PRODUCTS_MODERATE, (req) => service.getOwnerUserId(req.params.id)),
  controller.remove,
);

router.patch('/:id/moderate', authenticate, requirePermission(PERMISSIONS.PRODUCTS_MODERATE), validate({ body: moderateSchema }), controller.moderate);

// Compatibility alias for the admin front-end, which calls PATCH /:id/status
// with { status, reason } instead of PATCH /:id/moderate with { status, note }.
// Same permission, same service call as /moderate — just a field-name/path
// adapter, so both the canonical route (covered by the test suite) and the
// front-end's existing contract keep working without either one changing.
router.patch('/:id/status', authenticate, requirePermission(PERMISSIONS.PRODUCTS_MODERATE), validate({ body: statusAliasSchema }), controller.moderateByStatusAlias);

// Inventory management — owner-only (or admin/super-admin via the moderate override).
router.patch(
  '/:id/stock',
  authenticate,
  requireAnyPermission(PERMISSIONS.PRODUCTS_UPDATE_OWN, PERMISSIONS.PRODUCTS_MODERATE),
  requireOwnerOr(PERMISSIONS.PRODUCTS_MODERATE, (req) => service.getOwnerUserId(req.params.id)),
  validate({ body: stockSchema }),
  controller.updateStock,
);

// Active/inactive visibility toggle — owner-only (or admin/super-admin via the moderate override).
router.patch(
  '/:id/active',
  authenticate,
  requireAnyPermission(PERMISSIONS.PRODUCTS_UPDATE_OWN, PERMISSIONS.PRODUCTS_MODERATE),
  requireOwnerOr(PERMISSIONS.PRODUCTS_MODERATE, (req) => service.getOwnerUserId(req.params.id)),
  validate({ body: activeSchema }),
  controller.toggleActive,
);

// Image management — owner-only (or admin/super-admin). Accepts multipart
// (field name "image") via the shared upload middleware, or a JSON { url }.
router.post(
  '/:id/images',
  authenticate,
  requireAnyPermission(PERMISSIONS.PRODUCTS_UPDATE_OWN, PERMISSIONS.PRODUCTS_MODERATE),
  requireOwnerOr(PERMISSIONS.PRODUCTS_MODERATE, (req) => service.getOwnerUserId(req.params.id)),
  upload.single('image'),
  validate({ body: addImageSchema }),
  controller.addImage,
);
router.delete(
  '/:id/images/:imageId',
  authenticate,
  requireAnyPermission(PERMISSIONS.PRODUCTS_UPDATE_OWN, PERMISSIONS.PRODUCTS_MODERATE),
  requireOwnerOr(PERMISSIONS.PRODUCTS_MODERATE, (req) => service.getOwnerUserId(req.params.id)),
  controller.removeImage,
);

module.exports = router;
