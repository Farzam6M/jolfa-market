const router = require('express').Router();
const controller = require('./hero.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate, optionalAuthenticate } = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const upload = require('../../middlewares/upload.middleware');
const {
  createSchema, updateSchema, activeSchema, reorderSchema, listQuerySchema,
} = require('./hero.validation');

// Accepts an optional desktop + mobile image file in the same multipart
// request as the rest of the slide fields.
const uploadImages = upload.fields([
  { name: 'desktopImage', maxCount: 1 },
  { name: 'mobileImage', maxCount: 1 },
]);

// Public: only currently-active, in-schedule slides (unless a staff member
// with HERO_MANAGE passes ?includeInactive=true for the admin screen).
router.get('/', optionalAuthenticate, validate({ query: listQuerySchema }), controller.list);

// Bulk reorder — a literal path, so it MUST be registered before the
// parameterized '/:id' routes below to avoid "reorder" being matched as :id.
router.patch('/reorder', authenticate, requirePermission(PERMISSIONS.HERO_MANAGE), validate({ body: reorderSchema }), controller.reorder);

router.get('/:id', authenticate, requirePermission(PERMISSIONS.HERO_MANAGE), controller.getById); // staff-only (edit form)

router.post(
  '/',
  authenticate,
  requirePermission(PERMISSIONS.HERO_MANAGE),
  uploadImages,
  validate({ body: createSchema }),
  controller.create,
);

router.patch(
  '/:id',
  authenticate,
  requirePermission(PERMISSIONS.HERO_MANAGE),
  uploadImages,
  validate({ body: updateSchema }),
  controller.update,
);

router.patch('/:id/active', authenticate, requirePermission(PERMISSIONS.HERO_MANAGE), validate({ body: activeSchema }), controller.setActive);

router.delete('/:id', authenticate, requirePermission(PERMISSIONS.HERO_MANAGE), controller.remove);

module.exports = router;
