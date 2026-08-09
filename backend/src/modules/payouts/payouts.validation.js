const { z } = require('zod');

// Amount matches the Decimal(12,0) column (whole Toman, no fractional
// units) — same convention as products.validation.js's price field, but
// with .int() added since payout amounts, unlike prices, are always whole
// numbers at the DB level (Decimal(x, 0)).
const amountSchema = z.number().int('مبلغ برداشت باید عدد صحیح باشد').positive('مبلغ برداشت باید بزرگ‌تر از صفر باشد');

// Iranian Sheba (IBAN): "IR" + 24 digits, 26 chars total.
const ibanSchema = z.string().regex(/^IR\d{24}$/, 'شماره شبا نامعتبر است (فرمت صحیح: IR به همراه ۲۴ رقم)');

// Iranian bank card number: 16 digits, no spaces/dashes (caller normalizes before sending).
const cardNumberSchema = z.string().regex(/^\d{16}$/, 'شماره کارت باید ۱۶ رقم باشد');

const createPayoutSchema = z.object({
  amount: amountSchema,
  bankAccountHolder: z.string().min(2, 'نام صاحب حساب الزامی است').max(80),
  bankIban: ibanSchema,
  bankCardNumber: cardNumberSchema.optional(),
  bankName: z.string().min(2).max(60).optional(),
  // Optional client-supplied idempotency key so a retried/double-submitted
  // request is a safe no-op instead of reserving the amount twice — see
  // payouts.service.js#createPayout. The service generates one itself when
  // this is omitted.
  idempotencyKey: z.string().uuid('کلید idempotency نامعتبر است').optional(),
});

const rejectPayoutSchema = z.object({
  reason: z.string().max(500).optional(),
});

const markFailedPayoutSchema = z.object({
  failureReason: z.string().min(1, 'دلیل شکست الزامی است').max(500),
});

const idParamSchema = z.object({
  id: z.string().uuid('شناسه درخواست برداشت نامعتبر است'),
});

const payoutStatusEnum = z.enum(['REQUESTED', 'APPROVED', 'PROCESSED', 'REJECTED', 'FAILED']);

const listQuerySchema = z.object({
  status: payoutStatusEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// Admin listing additionally supports filtering by seller.
const adminListQuerySchema = listQuerySchema.extend({
  sellerId: z.string().uuid().optional(),
});

module.exports = {
  createPayoutSchema,
  rejectPayoutSchema,
  markFailedPayoutSchema,
  idParamSchema,
  listQuerySchema,
  adminListQuerySchema,
};
