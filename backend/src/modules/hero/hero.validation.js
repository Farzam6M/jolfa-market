const { z } = require('zod');
const { boolQuery } = require('../../utils/zodBooleanQuery');

// Button links render as an href on the public storefront, so only an
// absolute http(s) URL or an in-app relative path ("/shops") is accepted —
// this blocks a javascript:/data:/vbscript: scheme from ever being stored,
// even though only a HERO_MANAGE-holding admin can write this field.
const SAFE_LINK_REGEX = /^(https?:\/\/|\/)/i;
const buttonLinkSchema = z.string().min(1).max(2000).regex(SAFE_LINK_REGEX, 'لینک دکمه باید یک آدرس http(s) یا مسیر داخلی معتبر (شروع با /) باشد');

// The admin form submits as multipart/form-data (it's in the same request as
// the image file), and unlike JSON, a plain HTML/FormData submission sends
// every untouched optional text/date input as an empty string "" rather than
// omitting the key entirely. z.string().optional()/z.coerce.date().optional()
// only skip validation for an *absent* key (undefined) — an empty string
// still reaches .min(1)/.regex()/Date coercion and fails, which was turning
// "left button link blank" or "left schedule dates blank" into a 400 on
// every create/update. Normalizing "" -> undefined before the real schema
// runs restores the intended "optional" behavior for multipart submissions
// without changing anything for JSON callers (who simply omit the key).
const emptyToUndefined = (val) => (val === '' ? undefined : val);

// Shared fields between create/update. Image URLs are intentionally optional
// at the schema level — they may instead arrive as a multipart file upload
// (fields "desktopImage" / "mobileImage", handled by upload.middleware before
// this validator runs); the "a desktop image must exist somehow" rule is
// enforced in the controller once both sources have been considered.
// mobileImageUrl also accepts an explicit empty string on update, meaning
// "remove the mobile image and fall back to the desktop image" (see
// hero.controller.js's resolveImageUrl / hero.service.js's cleanup).
const baseFields = {
  subtitle: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  desktopImageUrl: z.string().url('آدرس تصویر دسکتاپ نامعتبر است').optional(),
  mobileImageUrl: z.union([z.string().url('آدرس تصویر موبایل نامعتبر است'), z.literal('')]).optional(),
  primaryButtonText: z.string().max(60).optional(),
  primaryButtonLink: z.preprocess(emptyToUndefined, buttonLinkSchema.optional()),
  secondaryButtonText: z.string().max(60).optional(),
  secondaryButtonLink: z.preprocess(emptyToUndefined, buttonLinkSchema.optional()),
  // Optional on write: when omitted, the service appends the slide to the
  // end of the current order. Accepts a numeric string too (multipart form
  // fields arrive as strings), hence z.coerce.
  displayOrder: z.coerce.number().int().min(0).optional(),
  // Where the text/button column sits over the slide image. Omitted on
  // create -> the service/DB default ('right') applies; omitted on update
  // -> the existing value is left untouched (same convention as the other
  // optional fields here).
  contentPosition: z.preprocess(emptyToUndefined, z.enum(['right', 'left', 'center']).optional()),
  startAt: z.preprocess(emptyToUndefined, z.coerce.date().optional()),
  endAt: z.preprocess(emptyToUndefined, z.coerce.date().optional()),
};

// A slide with only a button link and no button text (or vice versa) is a
// half-configured button, so the pair must be filled in together.
const buttonPairRefinement = (val, ctx) => {
  if (!!val.primaryButtonText !== !!val.primaryButtonLink && (val.primaryButtonText !== undefined || val.primaryButtonLink !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['primaryButtonLink'], message: 'متن و لینک دکمه اصلی باید هر دو مقداردهی شوند' });
  }
  if (!!val.secondaryButtonText !== !!val.secondaryButtonLink && (val.secondaryButtonText !== undefined || val.secondaryButtonLink !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['secondaryButtonLink'], message: 'متن و لینک دکمه دوم باید هر دو مقداردهی شوند' });
  }
  if (val.startAt && val.endAt && val.endAt <= val.startAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endAt'], message: 'زمان پایان باید بعد از زمان شروع باشد' });
  }
};

// isActive is intentionally NOT accepted on create/update — a new slide
// always starts active; use the dedicated PATCH /:id/active endpoint to
// toggle it (same convention as the categories module).
const createSchema = z.object({
  title: z.string().min(1, 'عنوان الزامی است').max(150),
  ...baseFields,
}).superRefine(buttonPairRefinement);

const updateSchema = z.object({
  title: z.string().min(1).max(150).optional(),
  ...baseFields,
}).superRefine(buttonPairRefinement);

const activeSchema = z.object({
  isActive: z.boolean(),
});

const reorderSchema = z.object({
  // Full ordered list of slide ids, front-to-back. The service validates
  // that every id belongs to an existing slide before applying anything.
  order: z.array(z.string().uuid()).min(1),
});

const listQuerySchema = z.object({
  // Staff-only (enforced in the service): include disabled/out-of-schedule
  // slides too, for the admin management screen.
  includeInactive: boolQuery().optional(),
});

module.exports = {
  createSchema, updateSchema, activeSchema, reorderSchema, listQuerySchema,
};
