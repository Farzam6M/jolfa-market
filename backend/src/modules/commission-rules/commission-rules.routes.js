const router = require('express').Router();
const controller = require('./commission-rules.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const {
  createSchema, updateSchema, listQuerySchema, idParamSchema,
} = require('./commission-rules.validation');

// Admin-only surface end-to-end — every route requires commission:manage.
router.use(authenticate, requirePermission(PERMISSIONS.COMMISSION_MANAGE));

router.get('/', validate({ query: listQuerySchema }), controller.list);
router.post('/', validate({ body: createSchema }), controller.create);
router.patch('/:id', validate({ params: idParamSchema, body: updateSchema }), controller.update);
router.delete('/:id', validate({ params: idParamSchema }), controller.remove);

module.exports = router;