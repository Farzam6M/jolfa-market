const router = require('express').Router();
const controller = require('./payment-refunds.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const { idParamSchema } = require('./payment-refunds.validation');

// Admin-only surface — mirrors commission-rules.routes.js's pattern of
// gating the whole router on one permission up front.
router.use(authenticate, requirePermission(PERMISSIONS.ORDERS_REFUND));

router.patch('/:id/mark-processed', validate({ params: idParamSchema }), controller.markProcessed);

module.exports = router;
