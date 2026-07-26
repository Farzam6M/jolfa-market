const { z } = require('zod');

const updateSelfSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  avatarUrl: z.string().url().optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'BANNED']),
});

const listQuerySchema = z.object({
  role: z.enum(['CUSTOMER', 'SELLER', 'ADMIN', 'SUPER_ADMIN']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
});

const mobileSchema = z.string().regex(/^09\d{9}$/, 'شماره موبایل باید با 09 شروع و 11 رقم باشد');

/** Contact info (email/mobile) changes are kept separate from updateSelfSchema and require the current password, since they affect login credentials and verification state. */
const updateContactSchema = z.object({
  email: z.string().email('ایمیل نامعتبر است').optional(),
  mobile: mobileSchema.optional(),
  currentPassword: z.string().min(1, 'برای تغییر اطلاعات تماس، رمز عبور فعلی الزامی است'),
}).refine((data) => data.email !== undefined || data.mobile !== undefined, {
  message: 'حداقل یکی از ایمیل یا موبایل باید ارسال شود',
});

const addressSchema = z.object({
  fullName: z.string().min(2, 'نام گیرنده الزامی است').max(80),
  phone: z.string().min(8, 'شماره تماس نامعتبر است').max(20),
  province: z.string().min(2),
  city: z.string().min(2),
  addressLine: z.string().min(5, 'آدرس کامل را وارد کنید'),
  postalCode: z.string().max(20).optional(),
  isDefault: z.boolean().optional(),
});

const updateAddressSchema = addressSchema.partial();

const addressIdParamSchema = z.object({
  id: z.string().uuid('شناسه آدرس نامعتبر است'),
});

module.exports = {
  updateSelfSchema,
  updateStatusSchema,
  listQuerySchema,
  updateContactSchema,
  addressSchema,
  updateAddressSchema,
  addressIdParamSchema,
};
