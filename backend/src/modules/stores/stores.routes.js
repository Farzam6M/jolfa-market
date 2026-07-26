const router = require('express').Router();
const controller = require('./stores.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate, optionalAuthenticate } = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const {
  updateOwnSchema, createDirectSchema, moderateSchema, listQuerySchema,
} = require('./stores.validation');

router.get('/', optionalAuthenticate, validate({ query: listQuerySchema }), controller.list); // public
router.post('/', authenticate, requirePermission(PERMISSIONS.STORES_CREATE), validate({ body: createDirectSchema }), controller.createDirect);
router.get('/me', authenticate, requirePermission(PERMISSIONS.STORES_UPDATE_OWN), controller.getOwn);
router.patch('/me', authenticate, requirePermission(PERMISSIONS.STORES_UPDATE_OWN), validate({ body: updateOwnSchema }), controller.updateOwn);
router.patch('/:id/moderate', authenticate, requirePermission(PERMISSIONS.STORES_MODERATE), validate({ body: moderateSchema }), controller.moderate);
// Full admin edit of any store's details (name/description/etc) — status changes stay on /:id/moderate.
router.patch('/:id', authenticate, requirePermission(PERMISSIONS.STORES_MODERATE), validate({ body: updateOwnSchema }), controller.adminUpdate);
router.get('/:slug', optionalAuthenticate, controller.getBySlug); // public, keep last (catch-all slug)

module.exports = router;
