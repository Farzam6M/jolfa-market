const { z } = require('zod');

// GET /admin/payout-liabilities — same pagination convention as
// payouts.validation.js's adminListQuerySchema.
const liabilityStatusEnum = z.enum(['OUTSTANDING', 'RECOVERED']);

const adminListQuerySchema = z.object({
  status: liabilityStatusEnum.optional(),
  sellerId: z.string().uuid('شناسه فروشنده نامعتبر است').optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

module.exports = { adminListQuerySchema };
