const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { emitToUser, emitToSupportStaff } = require('../../realtime/socket');

/**
 * Central notification dispatcher — mirrors the frontend's pushNotification()
 * pattern (icon, text, target scope) so every real event (registration,
 * store application, product submission, comment, admin action, new chat
 * message) can notify exactly the right audience: everyone, a whole role,
 * or one specific user. Also pushes a live 'notification:new' event over
 * the WebSocket layer so connected clients update without polling.
 */
async function pushNotification({
  icon, text, actionUrl, scope = 'ALL', targetRole = null, targetUserId = null,
}) {
  const notification = await prisma.notification.create({
    data: {
      icon, text, actionUrl, scope, targetRole, targetUserId,
    },
  });

  if (scope === 'USER' && targetUserId) {
    emitToUser(targetUserId, 'notification:new', { notification });
  } else if (scope === 'ROLE' && targetRole === 'ADMIN') {
    emitToSupportStaff('notification:new', { notification });
  }
  // scope === 'ALL' has no single room to broadcast to safely without
  // tracking every connected socket's role; clients still pick it up on
  // their next GET /notifications poll or page navigation.

  return notification;
}

/** Notifications visible to a given user: matches ALL, their ROLE, or their USER id, minus ones they've dismissed. Each item is annotated with `read` (per-user). */
async function getVisibleForUser(user, { take = 20 } = {}) {
  const notifications = await prisma.notification.findMany({
    where: {
      OR: [
        { scope: 'ALL' },
        { scope: 'ROLE', targetRole: user.roleKey },
        { scope: 'USER', targetUserId: user.id },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take,
  });

  const ids = notifications.map((n) => n.id);
  const [dismissed, read] = await Promise.all([
    prisma.notificationDismissal.findMany({ where: { userId: user.id, notificationId: { in: ids } }, select: { notificationId: true } }),
    prisma.notificationRead.findMany({ where: { userId: user.id, notificationId: { in: ids } }, select: { notificationId: true } }),
  ]);
  const dismissedIds = new Set(dismissed.map((d) => d.notificationId));
  const readIds = new Set(read.map((r) => r.notificationId));

  return notifications
    .filter((n) => !dismissedIds.has(n.id))
    .map((n) => ({ ...n, read: readIds.has(n.id) }));
}

/** Same OR-scope as getVisibleForUser — a notification must actually be addressed to this user (ALL / their ROLE / their USER id) before they can create read/dismiss state for it. */
async function assertVisible(user, notificationId) {
  const notification = await prisma.notification.findFirst({
    where: {
      id: notificationId,
      OR: [
        { scope: 'ALL' },
        { scope: 'ROLE', targetRole: user.roleKey },
        { scope: 'USER', targetUserId: user.id },
      ],
    },
    select: { id: true },
  });
  if (!notification) throw ApiError.notFound('اعلان یافت نشد');
}

async function dismiss(user, notificationId) {
  await assertVisible(user, notificationId);
  return prisma.notificationDismissal.upsert({
    where: { notificationId_userId: { notificationId, userId: user.id } },
    update: {},
    create: { notificationId, userId: user.id },
  });
}

/** Marks a single notification as read for this user (does not dismiss/remove it). */
async function markRead(user, notificationId) {
  await assertVisible(user, notificationId);
  return prisma.notificationRead.upsert({
    where: { notificationId_userId: { notificationId, userId: user.id } },
    update: {},
    create: { notificationId, userId: user.id },
  });
}

/** Marks every currently-visible notification as read for this user. */
async function markAllRead(userId, user) {
  const visible = await getVisibleForUser(user, { take: 200 });
  const unread = visible.filter((n) => !n.read);
  await prisma.$transaction(
    unread.map((n) => prisma.notificationRead.upsert({
      where: { notificationId_userId: { notificationId: n.id, userId } },
      update: {},
      create: { notificationId: n.id, userId },
    })),
  );
  return unread.length;
}

module.exports = {
  pushNotification, getVisibleForUser, dismiss, markRead, markAllRead,
};
