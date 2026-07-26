const { z } = require('zod');

const updateOwnSchema = z.object({
  name: z.string().min(2).optional(),
  categoryTag: z.string().optional(),
  region: z.string().optional(),
  description: z.string().optional(),
  logoUrl: z.string().url().optional(),
});

/**
 * Admin's "create store directly" form (no seller-application step).
 * mobile/password are optional: if omitted, credentials are generated
 * server-side (mirrors the previous frontend-only mock behaviour); if a
 * mobile already belongs to a CUSTOMER account, that account's password
 * must be supplied to prove ownership before it's upgraded to SELLER.
 */
const createDirectSchema = z.object({
  name: z.string().min(2),
  categoryTag: z.string().optional(),
  region: z.string().optional(),
  description: z.string().optional(),
  logoUrl: z.string().url().optional(),
  mobile: z.string().regex(/^09\d{9}$/).optional(),
  password: z.string().min(4).optional(),
});

const moderateSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'SUSPENDED']),
});

const listQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED']).optional(),
  region: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

module.exports = {
  updateOwnSchema, createDirectSchema, moderateSchema, listQuerySchema,
};
