const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const ApiError = require('../../utils/ApiError');
const { prisma } = require('../../config/database');
const service = require('./support-chat.service');

// ── Support (user ↔ admin) — every conversation is keyed 1:1 by userId,
// exactly like the old localStorage engine (conversation.id === user.id
// there). This keeps the frontend adapter a thin, mechanical mapping. ──

const getMySupport = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.getMySupportConversation(req.user.id)));
});

const sendSupport = asyncHandler(async (req, res) => {
  res.status(201).json(new ApiResponse(await service.sendSupportMessage(req.user.id, req.user.roleKey, req.body.body)));
});

const markSupportReadUser = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.markSupportReadByUser(req.user.id)));
});

const listAllSupport = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.listAllSupportConversations()));
});

// Admin drill-in: view one specific user's ticket (never creates one).
const getSupportForUser = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.getMySupportConversation(req.params.userId)));
});

// Admin reply: only allowed if the user already has a ticket (never creates one).
const replySupport = asyncHandler(async (req, res) => {
  const existing = await service.getMySupportConversation(req.params.userId);
  if (!existing) throw ApiError.notFound('این کاربر هنوز تیکتی ثبت نکرده است');
  const message = await service.sendSupportMessage(req.params.userId, 'ADMIN', req.body.body);
  res.status(201).json(new ApiResponse(message));
});

const markSupportReadAdmin = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.markSupportReadByAdmin(req.params.userId)));
});

// ── Store chat (customer ↔ seller) — unchanged from before, still keyed by storeId ──
const getStoreConversation = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.getOrCreateStoreConversation(req.params.storeId, req.user.id)));
});

const sendToStore = asyncHandler(async (req, res) => {
  const message = await service.sendStoreMessage({
    storeId: req.params.storeId, customerId: req.user.id, senderId: req.user.id, from: 'CUSTOMER', body: req.body.body,
  });
  res.status(201).json(new ApiResponse(message));
});

const markStoreReadCustomer = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.markStoreConversationReadByCustomer(req.params.storeId, req.user.id)));
});

const listMyStoreConversations = asyncHandler(async (req, res) => {
  const store = await prisma.store.findUnique({ where: { sellerId: req.user.id } });
  if (!store) throw ApiError.notFound('فروشگاهی برای این کاربر یافت نشد');
  res.json(new ApiResponse(await service.listStoreConversationsForSeller(store.id)));
});

const replyAsStore = asyncHandler(async (req, res) => {
  const conv = await service.assertParticipant(req.params.conversationId, req.user.id, 'store');
  if (conv.store.sellerId !== req.user.id) throw ApiError.forbidden('شما مالک این فروشگاه نیستید');
  const message = await service.sendStoreMessage({
    storeId: conv.storeId, customerId: conv.customerId, senderId: req.user.id, from: 'STORE', body: req.body.body,
  });
  res.status(201).json(new ApiResponse(message));
});

const markStoreReadSeller = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.markStoreConversationReadBySeller(req.params.conversationId, req.user.id)));
});

module.exports = {
  getMySupport,
  sendSupport,
  markSupportReadUser,
  listAllSupport,
  getSupportForUser,
  replySupport,
  markSupportReadAdmin,
  getStoreConversation,
  sendToStore,
  markStoreReadCustomer,
  listMyStoreConversations,
  replyAsStore,
  markStoreReadSeller,
};
