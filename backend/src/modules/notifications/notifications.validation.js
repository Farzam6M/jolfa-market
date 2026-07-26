const { z } = require('zod');

const broadcastSchema = z.object({
  icon: z.string().optional(),
  text: z.string().min(1),
  actionUrl: z.string().optional(),
  scope: z.enum(['ALL', 'ROLE', 'USER']).default('ALL'),
  targetRole: z.enum(['CUSTOMER', 'SELLER', 'ADMIN', 'SUPER_ADMIN']).optional(),
  targetUserId: z.string().uuid().optional(),
}).superRefine((val, ctx) => {
  if (val.scope === 'ROLE' && !val.targetRole) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetRole'], message: 'انتخاب نقش هدف الزامی است' });
  }
  if (val.scope === 'USER' && !val.targetUserId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['targetUserId'], message: 'انتخاب کاربر هدف الزامی است' });
  }
});

module.exports = { broadcastSchema };
