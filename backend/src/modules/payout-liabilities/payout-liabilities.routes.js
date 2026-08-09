const router = require('express').Router();
const controller = require('./payout-liabilities.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const { adminListQuerySchema } = require('./payout-liabilities.validation');

// Admin-only, read-only surface — same pattern as commission-report.routes.js
// and payouts.admin.routes.js: gate the whole router on one permission up
// front. Deliberately its own module (mirrors commission-rules/
// commission-report/payment-refunds/payouts.admin — see routes/index.js)
// rather than folded into admin.routes.js or payouts.admin.routes.js.
// No manual-recovery endpoint exists here or anywhere else (Phase 6:
// recovery is automatic-only) and this is never exposed on a
// seller-facing router.
router.use(authenticate, requirePermission(PERMISSIONS.PAYOUT_LIABILITIES_READ));

router.get('/', validate({ query: adminListQuerySchema }), controller.listAll);

module.exports = router;
