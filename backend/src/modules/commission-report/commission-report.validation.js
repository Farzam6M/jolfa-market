const { z } = require('zod');

// GET /admin/commission-report — read-only aggregate/listing over
// OrderItemSettlement. Pagination follows the same convention as
// products.validation.js's listQuerySchema (coerced, capped pageSize).
const reportQuerySchema = z.object({
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  storeId: z.string().uuid('شناسه فروشگاه نامعتبر است').optional(),
  commissionRuleId: z.string().uuid('شناسه قانون کمیسیون نامعتبر است').optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).refine((val) => !val.dateFrom || !val.dateTo || val.dateTo >= val.dateFrom, {
  message: 'پایان بازه زمانی باید بعد از شروع آن باشد',
  path: ['dateTo'],
});

module.exports = { reportQuerySchema };
