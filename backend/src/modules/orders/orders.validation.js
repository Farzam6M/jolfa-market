const { z } = require('zod');

const checkoutSchema = z.object({
  addressId: z.string().uuid().optional(),
});

// PENDING is the only entry state (set automatically at checkout) and is
// never a valid target for this endpoint — every other transition is
// checked against ORDER_TRANSITIONS in the service layer too, so an
// out-of-order jump (e.g. PENDING -> DELIVERED) is rejected even though
// it's syntactically a valid enum value here.
const updateStatusSchema = z.object({
  status: z.enum(['CONFIRMED', 'PREPARING', 'SENT', 'DELIVERED', 'CANCELLED']),
});

// GET /orders/settlements (seller, scoped to their own store — see
// orders.service.js#listSettlementsForStore). Pagination follows the same
// convention as products.validation.js's listQuerySchema.
const listSettlementsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// POST /orders/:id/refund (admin, ORDERS_REFUND — see
// orders.service.js#refundDeliveredOrder). No idempotencyKey field here:
// the service generates its own per-call, since duplicate-request safety
// for this endpoint comes from the over-refund check running at
// Serializable isolation, not from a client-supplied key.
const refundOrderSchema = z.object({
  items: z.array(z.object({
    orderItemId: z.string().uuid('شناسه قلم سفارش نامعتبر است'),
    qty: z.number().int('تعداد باید عدد صحیح باشد').positive('تعداد باید بزرگ‌تر از صفر باشد'),
  })).min(1, 'حداقل یک قلم برای استرداد لازم است'),
  reason: z.string().max(500).optional(),
});

module.exports = {
  checkoutSchema, updateStatusSchema, listSettlementsQuerySchema, refundOrderSchema,
};
