const router = require('express').Router();
const controller = require('./cart.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const { addItemSchema, updateItemSchema } = require('./cart.validation');

router.use(authenticate, requirePermission(PERMISSIONS.CART_MANAGE_SELF));
router.get('/', controller.getCart);
router.post('/items', validate({ body: addItemSchema }), controller.addItem);
router.patch('/items/:itemId', validate({ body: updateItemSchema }), controller.updateItem);
router.delete('/items/:itemId', controller.removeItem);
router.delete('/', controller.clear);

module.exports = router;
