const router = require('express').Router();
const controller = require('./admin.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const { createAdminSchema, sellerIdParamSchema } = require('./admin.validation');

router.use(authenticate);
router.get('/overview', requirePermission(PERMISSIONS.ADMIN_DASHBOARD), controller.overview);
router.get('/activity-log', requirePermission(PERMISSIONS.ADMIN_ACTIVITY_LOG), controller.activityLog);
// Only super_admin holds ADMINS_MANAGE (max-admins business rule enforced in users.service).
router.post('/admins', requirePermission(PERMISSIONS.ADMINS_MANAGE), validate({ body: createAdminSchema }), controller.createAdmin);
// Admin (with sellers:delete) or super_admin (wildcard) — see sellers.service.js removeSeller()
// for why this is a safe soft-delete rather than a raw SQL DELETE.
router.delete('/sellers/:sellerId', requirePermission(PERMISSIONS.SELLERS_DELETE), validate({ params: sellerIdParamSchema }), controller.deleteSeller);

module.exports = router;
