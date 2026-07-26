const { z } = require('zod');

const createSchema = z.object({
  productId: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
});

const moderateSchema = z.object({ status: z.enum(['APPROVED', 'REJECTED']) });

module.exports = { createSchema, moderateSchema };
