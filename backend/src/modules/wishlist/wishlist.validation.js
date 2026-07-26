const { z } = require('zod');
const addSchema = z.object({ productId: z.string().uuid() });
module.exports = { addSchema };
