const router = require('express').Router();
const controller = require('./payouts.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const {
  idParamSchema, adminListQuerySchema, rejectPayoutSchema, markFailedPayoutSchema,
} = require('./payouts.validation');

// Admin-only surface end-to-end — mirrors commission-rules.routes.js's
// pattern of gating the whole router on one permission up front.
router.use(authenticate, requirePermission(PERMISSIONS.PAYOUTS_MANAGE));

router.get('/', validate({ query: adminListQuerySchema }), controller.listAll);
router.patch('/:id/approve', validate({ params: idParamSchema }), controller.approve);
router.patch('/:id/reject', validate({ params: idParamSchema, body: rejectPayoutSchema }), controller.reject);
router.patch('/:id/mark-processed', validate({ params: idParamSchema }), controller.markProcessed);
// Deliberately a separate endpoint from /reject — APPROVED -> FAILED is an
// independent transition representing an attempted-but-failed off-platform
// transfer, not an up-front decline (see payouts.service.js#markFailed).
router.patch('/:id/mark-failed', validate({ params: idParamSchema, body: markFailedPayoutSchema }), controller.markFailed);

module.exports = router;
