const { z } = require('zod');
const { boolQuery } = require('../../utils/zodBooleanQuery');

// isActive is intentionally NOT accepted on create — new categories always
// start active; use the dedicated PATCH /:id/active endpoint to toggle it.
// Keeping it out of create/update bodies also closes a mass-assignment path
// (a caller can't sneak isActive into a generic update payload).
const createSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, 'اسلاگ باید فقط شامل حروف کوچک، عدد و خط تیره باشد'),
  icon: z.string().max(300).optional(),
  parentId: z.string().uuid().optional(),
});

const updateSchema = createSchema.partial();

const activeSchema = z.object({
  isActive: z.boolean(),
});

const listQuerySchema = z.object({
  // Only honored for staff (see service layer) — everyone else always gets
  // the active-only tree regardless of what they pass here.
  includeInactive: boolQuery().optional(),
});

module.exports = {
  createSchema, updateSchema, activeSchema, listQuerySchema,
};
