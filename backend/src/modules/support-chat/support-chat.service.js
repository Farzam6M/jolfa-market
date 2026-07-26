const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { pushNotification } = require('../notifications/notifications.service');
const { emitToUser, emitToSupportStaff, emitToStore } = require('../../realtime/socket');

/* ══════════════════════════════════════════════════════════════════
   Mirrors the frontend's chat-service.js rules exactly, now backed by
   the DB instead of localStorage:
     - one SUPPORT conversation per user (never created before the first message)
     - one STORE conversation per (store, customer) pair
     - read state is a per-side watermark (userReadAt/adminReadAt,
       customerReadAt/storeReadAt), exactly like the old localStorage
       engine — a message counts as "read" by a viewer iff
       message.createdAt <= that viewer's watermark.
   ══════════════════════════════════════════════════════════════════ */

function decorateMessages(messages, readAt) {
  const watermark = readAt ? new Date(readAt).getTime() : 0;
  return messages.map((m) => ({ ...m, read: new Date(m.createdAt).getTime() <= watermark }));
}

function unreadCount(messages, fromWanted, readAt) {
  const watermark = readAt ? new Date(readAt).getTime() : 0;
  return messages.filter((m) => m.from === fromWanted && new Date(m.createdAt).getTime() > watermark).length;
}

// ── Support (user ↔ admin staff) ──
async function getMySupportConversation(userId) {
  const conv = await prisma.supportConversation.findUnique({
    where: { userId },
    include: {
      user: { select: { id: true, name: true, role: { select: { key: true } } } },
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!conv) return null;
  return { ...conv, messages: decorateMessages(conv.messages, conv.userReadAt) };
}

async function sendSupportMessage(userId, senderRole, body) {
  const conversation = await prisma.supportConversation.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
  const from = senderRole === 'CUSTOMER' || senderRole === 'SELLER' ? 'USER' : 'SUPPORT';
  const message = await prisma.supportMessage.create({
    data: {
      conversationId: conversation.id, senderId: userId, from, body,
    },
  });
  await prisma.supportConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });

  if (from === 'USER') {
    await pushNotification({ icon: 'i-chat', text: 'پیام جدید در پشتیبانی', scope: 'ROLE', targetRole: 'ADMIN' });
    emitToSupportStaff('chat:support:message', { conversationId: conversation.id, userId: conversation.userId, message });
  } else {
    await pushNotification({ icon: 'i-chat', text: 'پاسخ جدید پشتیبانی', scope: 'USER', targetUserId: conversation.userId });
    emitToUser(conversation.userId, 'chat:support:message', { conversationId: conversation.id, userId: conversation.userId, message });
  }
  return message;
}

async function listAllSupportConversations() {
  const conversations = await prisma.supportConversation.findMany({
    include: {
      user: { select: { id: true, name: true, role: { select: { key: true } } } },
      messages: { orderBy: { createdAt: 'asc' } },
    },
    orderBy: { updatedAt: 'desc' },
  });
  return conversations.map((c) => ({
    ...c,
    messages: decorateMessages(c.messages, c.adminReadAt),
    unread: unreadCount(c.messages, 'USER', c.adminReadAt),
    lastMessage: c.messages[c.messages.length - 1] || null,
  }));
}

async function markSupportReadByUser(userId) {
  if (!userId) return null;
  const conv = await prisma.supportConversation.findUnique({ where: { userId } });
  if (!conv) return null; // never create a conversation just from a read-mark
  return prisma.supportConversation.update({ where: { userId }, data: { userReadAt: new Date() } });
}

async function markSupportReadByAdmin(userId) {
  if (!userId) return null;
  const conv = await prisma.supportConversation.findUnique({ where: { userId } });
  if (!conv) return null;
  return prisma.supportConversation.update({ where: { userId }, data: { adminReadAt: new Date() } });
}

// ── Store chat (customer ↔ seller) ──

// A customer may only open a chat with a store they have an actual
// buy/sell relationship with — i.e. at least one order containing an
// item from that store. Without this check any authenticated customer
// could message any store with no prior interaction.
async function assertPurchaseRelation(storeId, customerId) {
  const item = await prisma.orderItem.findFirst({
    where: { storeId, order: { userId: customerId } },
    select: { id: true },
  });
  if (!item) throw ApiError.forbidden('شما سابقه خرید از این فروشگاه ندارید');
}

/**
 * Loads the store (with its owning seller) and rejects new conversations/
 * messages once the store is SUSPENDED or its seller has been soft-deleted
 * (see removeSeller() in sellers.service.js). Existing conversations/messages
 * are never touched by this check — it only guards the creation of *new*
 * conversations and *new* messages, so chat history always stays readable.
 */
async function assertStoreUsable(storeId) {
  const store = await prisma.store.findUnique({ where: { id: storeId }, include: { seller: true } });
  if (!store) throw ApiError.notFound('فروشگاه یافت نشد');
  if (store.status === 'SUSPENDED' || (store.seller && store.seller.deletedAt)) {
    throw ApiError.conflict('این فروشگاه غیرفعال است و امکان گفتگوی جدید با آن وجود ندارد');
  }
  return store;
}

async function getOrCreateStoreConversation(storeId, customerId) {
  // Reads should not silently create a conversation with an unrelated
  // store — only allow the read if either a relationship exists, or the
  // conversation was already legitimately created before.
  const existing = await prisma.storeConversation.findUnique({
    where: { storeId_customerId: { storeId, customerId } },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!existing) {
    // Only a brand-new conversation is blocked for a suspended/deleted-seller
    // store — an already-existing conversation (the `existing` branch below)
    // must stay readable regardless of the store's current status.
    await assertStoreUsable(storeId);
    await assertPurchaseRelation(storeId, customerId);
    const conv = await prisma.storeConversation.create({
      data: { storeId, customerId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    return { ...conv, messages: decorateMessages(conv.messages, conv.customerReadAt) };
  }
  return { ...existing, messages: decorateMessages(existing.messages, existing.customerReadAt) };
}

async function sendStoreMessage({
  storeId, customerId, senderId, from, body,
}) {
  // A new message (from either side) must never be sent once the store is
  // suspended or its seller soft-deleted — this reuses the fetched store
  // below for the existing notification text, no extra query added.
  const store = await assertStoreUsable(storeId);
  if (from === 'CUSTOMER') {
    const existing = await prisma.storeConversation.findUnique({
      where: { storeId_customerId: { storeId, customerId } },
    });
    if (!existing) await assertPurchaseRelation(storeId, customerId);
  }
  const conversation = await prisma.storeConversation.upsert({
    where: { storeId_customerId: { storeId, customerId } },
    update: {},
    create: { storeId, customerId },
  });
  const message = await prisma.storeMessage.create({
    data: {
      conversationId: conversation.id, senderId, from, body,
    },
  });
  await prisma.storeConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });

  if (from === 'CUSTOMER') {
    await pushNotification({ icon: 'i-chat', text: `پیام جدید در فروشگاه «${store.name}»`, scope: 'USER', targetUserId: store.sellerId });
    emitToStore(storeId, 'chat:store:message', {
      conversationId: conversation.id, storeId, customerId, message,
    });
  } else {
    await pushNotification({ icon: 'i-chat', text: `پاسخ جدید از فروشگاه «${store.name}»`, scope: 'USER', targetUserId: customerId });
    emitToUser(customerId, 'chat:store:message', {
      conversationId: conversation.id, storeId, customerId, message,
    });
  }
  return message;
}

async function listStoreConversationsForSeller(storeId) {
  const conversations = await prisma.storeConversation.findMany({
    where: { storeId },
    include: { customer: { select: { id: true, name: true } }, messages: { orderBy: { createdAt: 'asc' } } },
    orderBy: { updatedAt: 'desc' },
  });
  return conversations.map((c) => ({
    ...c,
    unread: unreadCount(c.messages, 'CUSTOMER', c.storeReadAt),
    lastMessage: c.messages[c.messages.length - 1] || null,
  }));
}

async function markStoreConversationReadByCustomer(storeId, customerId) {
  const conv = await prisma.storeConversation.findUnique({ where: { storeId_customerId: { storeId, customerId } } });
  if (!conv) return null;
  return prisma.storeConversation.update({ where: { id: conv.id }, data: { customerReadAt: new Date() } });
}

async function markStoreConversationReadBySeller(conversationId, sellerId) {
  const conv = await prisma.storeConversation.findUnique({ where: { id: conversationId }, include: { store: true } });
  if (!conv) return null;
  if (conv.store.sellerId !== sellerId) throw ApiError.forbidden('شما مالک این فروشگاه نیستید');
  return prisma.storeConversation.update({ where: { id: conversationId }, data: { storeReadAt: new Date() } });
}

async function assertParticipant(conversationId, userId, kind) {
  if (kind === 'support') {
    const conv = await prisma.supportConversation.findUnique({ where: { id: conversationId } });
    if (!conv) throw ApiError.notFound('گفتگو یافت نشد');
    return conv;
  }
  const conv = await prisma.storeConversation.findUnique({ where: { id: conversationId }, include: { store: true } });
  if (!conv) throw ApiError.notFound('گفتگو یافت نشد');
  return conv;
}

module.exports = {
  getMySupportConversation,
  sendSupportMessage,
  listAllSupportConversations,
  markSupportReadByUser,
  markSupportReadByAdmin,
  getOrCreateStoreConversation,
  sendStoreMessage,
  listStoreConversationsForSeller,
  markStoreConversationReadByCustomer,
  markStoreConversationReadBySeller,
  assertParticipant,
};
