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

module.exports = { checkoutSchema, updateStatusSchema, listSettlementsQuerySchema };
