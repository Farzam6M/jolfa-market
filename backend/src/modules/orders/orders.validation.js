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

module.exports = { checkoutSchema, updateStatusSchema };
