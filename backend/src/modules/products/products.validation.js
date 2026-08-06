const { z } = require('zod');
const { boolQuery } = require('../../utils/zodBooleanQuery');

const MAX_IMAGES = 8;

const wholesaleTierSchema = z.object({
  minQty: z.number().int().positive(),
  price: z.number().positive(),
});

// Product images can be either a fully-qualified external URL (e.g. a seed
// placeholder or an admin-provided CDN link) OR a local path produced by our
// own upload.middleware.js (`/uploads/<timestamp>-<random><ext>`, no nested
// path segments). `z.string().url()` alone rejects that second, relative
// form — which is the exact shape POST /:id/images itself stores — so
// create/update must accept both, or the front-end can never resend its own
// current image list (e.g. to reorder) through PATCH /:id. The regex only
// allows the literal filename characters upload.middleware.js can produce,
// so this can't be used to smuggle a path-traversal segment through create/update.
const LOCAL_UPLOAD_PATH = /^\/uploads\/[A-Za-z0-9._-]+$/;
const productImageUrlSchema = z.string().refine(
  (val) => LOCAL_UPLOAD_PATH.test(val) || z.string().url().safeParse(val).success,
  { message: 'آدرس تصویر نامعتبر است' },
);

// price/compareAtPrice/discount rule: compareAtPrice (the "was" price shown
// struck-through) must be strictly greater than price when present — a
// discount that isn't actually a discount (or that makes the sale price
// exceed the original) is rejected here rather than left for the UI to hide.
const priceRefinement = (val, ctx) => {
  if (val.compareAtPrice !== undefined && val.compareAtPrice !== null && val.price !== undefined) {
    if (val.compareAtPrice <= val.price) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['compareAtPrice'],
        message: 'قیمت قبل از تخفیف باید بیشتر از قیمت فعلی باشد',
      });
    }
  }
};

// Identity fields — shared with buildIdentityKey() in products.service.js.
// These describe the global Product; everything else in createSchema
// describes THIS store's offer of it.
const identitySchema = {
  name: z.string().min(2).max(200),
  brand: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  capacity: z.string().max(50).optional(),
  color: z.string().max(50).optional(),
  description: z.string().max(5000).optional(),
  specifications: z.record(z.string(), z.any()).optional(),
  categoryId: z.string().uuid().optional(),
};

const createSchema = z.object({
  ...identitySchema,
  price: z.number().positive(),
  compareAtPrice: z.number().positive().optional(),
  stock: z.number().int().min(0).default(0),
  warranty: z.string().max(200).optional(),
  shippingTime: z.string().max(200).optional(),
  discount: z.number().int().min(0).max(100).optional(),
  type: z.enum(['RETAIL', 'WHOLESALE']).default('RETAIL'),
  images: z.array(productImageUrlSchema).max(MAX_IMAGES).optional(),
  wholesaleTiers: z.array(wholesaleTierSchema).optional(),
  // Only honored for a requester holding PRODUCTS_MODERATE (admin/super_admin);
  // a plain seller's own store is still always used regardless of this field —
  // enforced in products.service#create, not here.
  storeId: z.string().uuid().optional(),
}).superRefine(priceRefinement);

// `.partial()` on a refined schema drops the refinement, so it's re-applied here.
const updateSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  categoryId: z.string().uuid().optional(),
  brand: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  capacity: z.string().max(50).optional(),
  color: z.string().max(50).optional(),
  description: z.string().max(5000).optional(),
  specifications: z.record(z.string(), z.any()).optional(),
  price: z.number().positive().optional(),
  compareAtPrice: z.number().positive().optional(),
  stock: z.number().int().min(0).optional(),
  warranty: z.string().max(200).optional(),
  shippingTime: z.string().max(200).optional(),
  discount: z.number().int().min(0).max(100).optional(),
  type: z.enum(['RETAIL', 'WHOLESALE']).optional(),
  images: z.array(productImageUrlSchema).max(MAX_IMAGES).optional(),
  wholesaleTiers: z.array(wholesaleTierSchema).optional(),
}).superRefine(priceRefinement);

// A rejection must always carry a reason for the seller — only APPROVED can
// go without one. (The front-end already enforces this client-side; this is
// the server-side guarantee that can't be bypassed by calling the API directly.)
const moderateSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  note: z.string().max(1000).optional(),
}).superRefine((val, ctx) => {
  if (val.status === 'REJECTED' && !val.note?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['note'], message: 'ثبت دلیل رد الزامی است' });
  }
});

// Same rule as moderateSchema, under the field name the admin front-end
// actually sends ("reason" instead of "note") — see PATCH /:id/status.
const statusAliasSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().max(1000).optional(),
}).superRefine((val, ctx) => {
  if (val.status === 'REJECTED' && !val.reason?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'ثبت دلیل رد الزامی است' });
  }
});

// Dedicated inventory-management payload: SET assigns stock directly,
// INCREMENT/DECREMENT adjust the current value (e.g. restock or a sale).
const stockSchema = z.object({
  stock: z.number().int().min(0),
  mode: z.enum(['SET', 'INCREMENT', 'DECREMENT']).default('SET'),
});

const activeSchema = z.object({
  isActive: z.boolean(),
});

const listQuerySchema = z.object({
  categoryId: z.string().uuid().optional(),
  storeId: z.string().uuid().optional(),
  type: z.enum(['RETAIL', 'WHOLESALE']).optional(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'ARCHIVED']).optional(),
  q: z.string().max(200).optional(),
  minPrice: z.coerce.number().optional(),
  maxPrice: z.coerce.number().optional(),
  inStock: boolQuery().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});

const addImageSchema = z.object({
  url: z.string().url().optional(), // present when adding by URL instead of multipart upload
});

// GET /:productId/offers — :productId is the GLOBAL Product id (see
// products.service.js getOffersByProduct()), unlike every other :id route in
// this router which addresses a StoreProduct. Validated separately so a
// malformed id 400s here instead of falling through to a Prisma error.
const productIdParamSchema = z.object({
  productId: z.string().uuid('شناسه محصول نامعتبر است'),
});

module.exports = {
  createSchema,
  updateSchema,
  moderateSchema,
  statusAliasSchema,
  listQuerySchema,
  stockSchema,
  activeSchema,
  addImageSchema,
  productIdParamSchema,
  MAX_IMAGES,
};
