const router = require('express').Router();
const controller = require('./support-chat.controller');
const validate = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const { PERMISSIONS } = require('../roles/permissions.constants');
const { sendSupportMessageSchema, sendStoreMessageSchema } = require('./support-chat.validation');

router.use(authenticate);

/* ── Support (customer/seller ↔ admin/super-admin) ──
   Rule enforcement:
     - SUPPORT_CHAT_USE (customer/seller): can only ever touch their OWN
       ticket — routes below never take a userId from a USE-permission
       caller, they always use req.user.id. So a customer literally cannot
       address another customer's or a seller's ticket, and vice versa.
     - SUPPORT_CHAT_STAFF (admin/super_admin only): the only permission
       that unlocks the :userId-parameterized routes, i.e. "see/reply to
       any ticket". */
router.get('/support', requirePermission(PERMISSIONS.SUPPORT_CHAT_USE), controller.getMySupport);
router.post('/support', requirePermission(PERMISSIONS.SUPPORT_CHAT_USE), validate({ body: sendSupportMessageSchema }), controller.sendSupport);
router.post('/support/read', requirePermission(PERMISSIONS.SUPPORT_CHAT_USE), controller.markSupportReadUser);

router.get('/support/all', requirePermission(PERMISSIONS.SUPPORT_CHAT_STAFF), controller.listAllSupport);
router.get('/support/:userId', requirePermission(PERMISSIONS.SUPPORT_CHAT_STAFF), controller.getSupportForUser);
router.post('/support/:userId/reply', requirePermission(PERMISSIONS.SUPPORT_CHAT_STAFF), validate({ body: sendSupportMessageSchema }), controller.replySupport);
router.post('/support/:userId/read', requirePermission(PERMISSIONS.SUPPORT_CHAT_STAFF), controller.markSupportReadAdmin);

/* ── Store chat (customer ↔ seller) — unchanged, kept for future use ── */
router.get('/store/:storeId', requirePermission(PERMISSIONS.STORE_CHAT_CUSTOMER), controller.getStoreConversation);
router.post('/store/:storeId', requirePermission(PERMISSIONS.STORE_CHAT_CUSTOMER), validate({ body: sendStoreMessageSchema }), controller.sendToStore);
router.post('/store/:storeId/read', requirePermission(PERMISSIONS.STORE_CHAT_CUSTOMER), controller.markStoreReadCustomer);

router.get('/store-owner/conversations', requirePermission(PERMISSIONS.STORE_CHAT_SELLER), controller.listMyStoreConversations);
router.post('/store-owner/:conversationId/reply', requirePermission(PERMISSIONS.STORE_CHAT_SELLER), validate({ body: sendStoreMessageSchema }), controller.replyAsStore);
router.post('/store-owner/:conversationId/read', requirePermission(PERMISSIONS.STORE_CHAT_SELLER), controller.markStoreReadSeller);

module.exports = router;
