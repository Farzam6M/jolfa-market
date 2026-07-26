const { z } = require('zod');

const createAdminSchema = z.object({
  name: z.string().min(2),
  mobile: z.string().regex(/^09\d{9}$/),
  password: z.string().min(8),
});

const sellerIdParamSchema = z.object({
  sellerId: z.string().uuid('شناسه فروشنده نامعتبر است'),
});

module.exports = { createAdminSchema, sellerIdParamSchema };
