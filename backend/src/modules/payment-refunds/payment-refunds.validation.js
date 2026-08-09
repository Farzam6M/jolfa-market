const { z } = require('zod');

const idParamSchema = z.object({
  id: z.string().uuid('شناسه استرداد نامعتبر است'),
});

module.exports = { idParamSchema };
