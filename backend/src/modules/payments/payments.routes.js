const router = require('express').Router();
const controller = require('./payments.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const { verifyGatewaySignature } = require('../../middlewares/gateway.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const { paySchema, gatewayCallbackSchema, listQuerySchema } = require('./payments.validation');

// The real gateway calls this server-to-server — it has no user JWT, so it
// must stay OUTSIDE `authenticate` below. `verifyGatewaySignature` checks an
// HMAC over the raw body (see gateway.middleware.js) so an attacker can't
// POST a fake "success" for a transactionRef they merely guessed. Swap the
// verification scheme there for the chosen provider's actual mechanism
// before going live — this generic HMAC layer is a vendor-agnostic
// placeholder, not a claim that it matches any specific provider's contract.
router.post('/gateway/callback', verifyGatewaySignature, validate({ body: gatewayCallbackSchema }), controller.gatewayCallback);

router.use(authenticate);
router.post('/', requirePermission(PERMISSIONS.PAYMENTS_CREATE_SELF), validate({ body: paySchema }), controller.pay);
router.get('/wallet', requirePermission(PERMISSIONS.WALLET_READ_SELF), controller.getWallet);
// Admin-only: browse payments across all users/orders (was previously unwired dead permission).
router.get('/', requirePermission(PERMISSIONS.PAYMENTS_READ_ANY), validate({ query: listQuerySchema }), controller.list);

module.exports = router;
