const router = require('express').Router();
const controller = require('./wishlist.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const { addSchema } = require('./wishlist.validation');

router.use(authenticate, requirePermission(PERMISSIONS.WISHLIST_MANAGE_SELF));
router.get('/', controller.list);
router.post('/', validate({ body: addSchema }), controller.add);
router.delete('/:productId', controller.remove);

module.exports = router;
