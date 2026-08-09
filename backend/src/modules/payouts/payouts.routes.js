const router = require('express').Router();
const controller = require('./payouts.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const { createPayoutSchema, listQuerySchema } = require('./payouts.validation');

// Seller-only surface — mirrors payments.routes.js's pattern of gating on
// WALLET_WITHDRAW_SELF; ownership itself is enforced in the service layer
// by always scoping to req.user.id (never a client-supplied sellerId).
router.use(authenticate, requirePermission(PERMISSIONS.WALLET_WITHDRAW_SELF));

router.post('/', validate({ body: createPayoutSchema }), controller.create);
router.get('/', validate({ query: listQuerySchema }), controller.listMine);

module.exports = router;
