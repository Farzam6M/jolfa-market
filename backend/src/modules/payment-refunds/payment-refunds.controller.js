const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const paymentsService = require('../payments/payments.service');

// Business logic lives in payments.service.js (it's fundamentally a
// Payment/PaymentRefund operation) — this module is just the admin-facing
// route surface for it, same rationale as commission-rules/
// commission-report living outside admin.routes.js (see routes/index.js).
const markProcessed = asyncHandler(async (req, res) => res.json(
  new ApiResponse(await paymentsService.markGatewayRefundProcessed(req.params.id, req.user), 'استرداد درگاه پرداخت تأیید شد'),
));

module.exports = { markProcessed };
