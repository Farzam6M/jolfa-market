const { z } = require('zod');

const sendSupportMessageSchema = z.object({ body: z.string().min(1) });
const sendStoreMessageSchema = z.object({ body: z.string().min(1) });

module.exports = { sendSupportMessageSchema, sendStoreMessageSchema };
