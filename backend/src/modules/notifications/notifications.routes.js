const router = require('express').Router();
const controller = require('./notifications.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const { broadcastSchema } = require('./notifications.validation');

router.use(authenticate);
router.get('/', requirePermission(PERMISSIONS.NOTIFICATIONS_READ_SELF), controller.list);
router.patch('/:id/read', requirePermission(PERMISSIONS.NOTIFICATIONS_READ_SELF), controller.markRead);
router.post('/read-all', requirePermission(PERMISSIONS.NOTIFICATIONS_READ_SELF), controller.markAllRead);
router.delete('/:id', requirePermission(PERMISSIONS.NOTIFICATIONS_READ_SELF), controller.dismiss);
router.post('/broadcast', requirePermission(PERMISSIONS.NOTIFICATIONS_BROADCAST), validate({ body: broadcastSchema }), controller.broadcast);

module.exports = router;
