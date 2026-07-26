const { z } = require('zod');

const paySchema = z.object({
  orderId: z.string().uuid(),
  method: z.enum(['WALLET', 'GATEWAY', 'CASH_ON_DELIVERY']),
});

// Generic placeholder shape for a gateway webhook payload — every real
// provider (ZarinPal, IDPay, Stripe, ...) has its own field names, so this
// is deliberately the minimal common shape; swap it for the provider's
// actual schema when one is chosen, the rest of the flow (confirmGateway)
// doesn't need to change.
const gatewayCallbackSchema = z.object({
  transactionRef: z.string().min(1),
  success: z.boolean(),
});

const listQuerySchema = z.object({
  status: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'REFUNDED']).optional(),
  method: z.enum(['WALLET', 'GATEWAY', 'CASH_ON_DELIVERY']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

module.exports = {
  paySchema, gatewayCallbackSchema, listQuerySchema,
};
