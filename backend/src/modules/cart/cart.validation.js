const { z } = require('zod');

const addItemSchema = z.object({
  productId: z.string().uuid(),
  qty: z.number().int().positive().default(1),
});

const updateItemSchema = z.object({
  qty: z.number().int().positive(),
});

module.exports = { addItemSchema, updateItemSchema };
