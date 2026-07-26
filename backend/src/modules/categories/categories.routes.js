const router = require('express').Router();
const controller = require('./categories.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate, optionalAuthenticate } = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const {
  createSchema, updateSchema, activeSchema, listQuerySchema,
} = require('./categories.validation');

router.get('/', optionalAuthenticate, validate({ query: listQuerySchema }), controller.list); // public (active-only unless staff + includeInactive)
router.post('/', authenticate, requirePermission(PERMISSIONS.CATEGORIES_MANAGE), validate({ body: createSchema }), controller.create);
router.patch('/:id', authenticate, requirePermission(PERMISSIONS.CATEGORIES_MANAGE), validate({ body: updateSchema }), controller.update);
router.patch('/:id/active', authenticate, requirePermission(PERMISSIONS.CATEGORIES_MANAGE), validate({ body: activeSchema }), controller.setActive);
router.delete('/:id', authenticate, requirePermission(PERMISSIONS.CATEGORIES_MANAGE), controller.remove);

module.exports = router;
