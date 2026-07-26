const router = require('express').Router();
const controller = require('./orders.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { requirePermission, requireAnyPermission } = require('../../middlewares/rbac.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const { checkoutSchema, updateStatusSchema } = require('./orders.validation');

router.use(authenticate);
router.post('/checkout', requirePermission(PERMISSIONS.ORDERS_CREATE_SELF), validate({ body: checkoutSchema }), controller.checkout);
router.get('/mine', requirePermission(PERMISSIONS.ORDERS_READ_SELF), controller.listMine);
router.get('/store', requirePermission(PERMISSIONS.ORDERS_READ_STORE), controller.listForStore);
router.get('/:id', controller.getById); // ownership checked in service (customer / store owner / staff)
// Reachable by admin (orders:update:status, unrestricted) OR seller
// (orders:update:status:store, scoped to their own store's orders and to
// CONFIRMED->PREPARING->SENT only). The route only checks that the caller
// holds ONE of these two permissions — ownership, allowed target statuses,
// and the multi-seller-order guard are all enforced in the service layer.
router.patch('/:id/status', requireAnyPermission(PERMISSIONS.ORDERS_UPDATE_STATUS, PERMISSIONS.ORDERS_UPDATE_STATUS_STORE), validate({ body: updateStatusSchema }), controller.updateStatus);

module.exports = router;
