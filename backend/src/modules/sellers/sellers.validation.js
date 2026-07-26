const { z } = require('zod');

const applySchema = z.object({
  storeName: z.string().min(2),
  businessInfo: z.record(z.any()).optional(),
  documents: z.record(z.any()).optional(),
});

const reviewSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  note: z.string().optional(),
});

module.exports = { applySchema, reviewSchema };
