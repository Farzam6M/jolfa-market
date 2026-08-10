const { z } = require('zod');

// isActive is intentionally accepted on both create and update (unlike the
// categories/hero modules' dedicated PATCH /:id/active endpoint) since the
// Admin API surface approved for Phase 1 is exactly
// POST/GET/PATCH/DELETE /admin/commission-rules — there is no separate
// toggle route. The "can't deactivate the last active GLOBAL rule" business
// rule is still enforced in the service layer regardless of which endpoint
// flips isActive.
const scopeEnum = z.enum(['GLOBAL', 'SELLER', 'CATEGORY', 'CAMPAIGN']);

// Shared field-level shape. Cross-field combination rules (which fields are
// required/forbidden per scope) are enforced separately below via
// superRefine, and AGAIN in the service layer against the fully-merged
// record on update (see commission-rules.service.js#assertValidCombo) —
// the service-layer check is the authoritative one since a PATCH may only
// send a subset of fields.
const baseFields = {
  sellerId: z.string().uuid('شناسه فروشگاه نامعتبر است').optional(),
  categoryId: z.string().uuid('شناسه دسته‌بندی نامعتبر است').optional(),
  campaignStartAt: z.coerce.date().optional(),
  campaignEndAt: z.coerce.date().optional(),
  // Percentage, 2 decimal places, matches Decimal(5,2) in the schema (max 999.99 at
  // the DB level, but a commission rate is never sane above 100%).
  // Optional at the base-field level so PATCH can send a partial payload
  // (e.g. just `{ isActive: false }`) without being forced to resend rate.
  // createSchema enforces rate as required via its own superRefine below —
  // the same conditional-requirement pattern already used there for
  // sellerId/categoryId/campaignStartAt/campaignEndAt.
  rate: z.number().min(0, 'نرخ کمیسیون نمی‌تواند منفی باشد').max(100, 'نرخ کمیسیون نمی‌تواند بیشتر از ۱۰۰ باشد')
    .refine((v) => Math.round(v * 100) === v * 100, 'نرخ کمیسیون حداکثر تا دو رقم اعشار مجاز است')
    .optional(),
  priority: z.number().int('اولویت باید عدد صحیح باشد').optional(),
  isActive: z.boolean().optional(),
};

// Same-request structural sanity check (independent of any existing DB
// row) — e.g. a create payload can't claim scope GLOBAL and also send a
// sellerId in the very same request. This does NOT cover partial-update
// combinations that only become invalid once merged with the existing row
// (e.g. PATCH sending only `{ sellerId }` on a rule whose scope is already
// GLOBAL) — that is the service layer's job.
function refineScopeCombo(val, ctx) {
  const { scope } = val;
  if (scope === 'GLOBAL') {
    if (val.sellerId !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sellerId'], message: 'قانون سراسری (GLOBAL) نمی‌تواند به یک فروشگاه محدود شود' });
    if (val.categoryId !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['categoryId'], message: 'قانون سراسری (GLOBAL) نمی‌تواند به یک دسته‌بندی محدود شود' });
  }
  if (scope === 'SELLER' && val.categoryId !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['categoryId'], message: 'قانون مخصوص فروشگاه (SELLER) نمی‌تواند دسته‌بندی داشته باشد' });
  }
  if (scope === 'CATEGORY' && val.sellerId !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sellerId'], message: 'قانون مخصوص دسته‌بندی (CATEGORY) نمی‌تواند فروشگاه داشته باشد' });
  }
  if (scope !== 'CAMPAIGN' && (val.campaignStartAt !== undefined || val.campaignEndAt !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['campaignStartAt'], message: 'بازه زمانی کمپین فقط برای قانون‌های CAMPAIGN مجاز است' });
  }
  if (val.campaignStartAt && val.campaignEndAt && val.campaignEndAt <= val.campaignStartAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['campaignEndAt'], message: 'پایان کمپین باید بعد از شروع آن باشد' });
  }
}

const createSchema = z.object({
  scope: scopeEnum,
  ...baseFields,
}).superRefine((val, ctx) => {
  // rate is optional at the base-field level (so updateSchema can omit it
  // on a partial PATCH), but is always required on create, regardless of
  // scope — enforced here rather than in baseFields itself.
  if (val.rate === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['rate'], message: 'نرخ کمیسیون الزامی است' });
  if (val.scope === 'SELLER' && !val.sellerId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sellerId'], message: 'شناسه فروشگاه برای قانون SELLER الزامی است' });
  if (val.scope === 'CATEGORY' && !val.categoryId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['categoryId'], message: 'شناسه دسته‌بندی برای قانون CATEGORY الزامی است' });
  if (val.scope === 'CAMPAIGN' && (!val.campaignStartAt || !val.campaignEndAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['campaignStartAt'], message: 'زمان شروع و پایان کمپین برای قانون CAMPAIGN الزامی است' });
  }
  refineScopeCombo(val, ctx);
});

// scope is required on update too (not `.partial()`'d away) — every other
// field is optional, but omitting scope would make the combo-refinement
// above meaningless (it wouldn't know which rules to check against). The
// service layer merges this against the existing row before final
// validation, so callers may still send a no-op `{ scope: existing.scope }`
// alongside just the field(s) they actually want to change.
const updateSchema = z.object({
  scope: scopeEnum.optional(),
  ...baseFields,
}).superRefine((val, ctx) => {
  // Only check same-request internal consistency here; required-field-per-
  // scope and cross-field checks against the CURRENT row happen once the
  // service merges this with the existing record.
  refineScopeCombo(val, ctx);
});

const listQuerySchema = z.object({
  scope: scopeEnum.optional(),
  sellerId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
});

const idParamSchema = z.object({
  id: z.string().uuid('شناسه قانون کمیسیون نامعتبر است'),
});

module.exports = {
  createSchema, updateSchema, listQuerySchema, idParamSchema,
};