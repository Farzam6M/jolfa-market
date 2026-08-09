const router = require('express').Router();
const controller = require('./commission-report.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const { reportQuerySchema } = require('./commission-report.validation');

// Admin-only, read-only surface — mirrors commission-rules.routes.js's
// pattern of gating the whole router on one permission up front.
router.use(authenticate, requirePermission(PERMISSIONS.COMMISSION_MANAGE));

router.get('/', validate({ query: reportQuerySchema }), controller.report);

module.exports = router;
