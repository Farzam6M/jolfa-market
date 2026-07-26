const { Server } = require('socket.io');
const { verifyAccessToken } = require('../utils/tokens');
const { prisma } = require('../config/database');
const env = require('../config/env');
const logger = require('../utils/logger');

/* ══════════════════════════════════════════════════════════════════
   Real-time layer for chat + notifications.

   Rooms (this is the whole isolation model — nobody joins a room they
   are not entitled to, so the same access rules the REST API enforces
   are enforced again here, independently, at connection time):
     user:{userId}            → private channel, every authenticated user joins their own
     role:ADMIN_STAFF         → ADMIN + SUPER_ADMIN only (support inbox live view)
     store:{storeId}          → the seller who owns that store only

   Events emitted (consumed by chat-service.js on the frontend):
     'chat:support:message'   { conversationId, userId, message }
     'chat:store:message'     { conversationId, storeId, customerId, message }
     'notification:new'       { notification }

   This module intentionally has ZERO business logic — it is only a
   transport. All authorization/creation rules stay in the services
   (support-chat.service.js / notifications.service.js), which call the
   emit* helpers below after a DB write succeeds.
   ══════════════════════════════════════════════════════════════════ */

let io = null;

function initRealtime(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: env.corsOrigins.includes('*') ? true : env.corsOrigins,
      credentials: true,
    },
    path: '/socket.io',
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token
        || (socket.handshake.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token) return next(new Error('توکن احراز هویت ارسال نشده است'));

      const payload = verifyAccessToken(token);
      const user = await prisma.user.findUnique({ where: { id: payload.sub }, include: { role: true } });
      if (!user || user.status !== 'ACTIVE') return next(new Error('کاربر معتبر نیست'));

      socket.user = { id: user.id, roleKey: user.role.key, name: user.name };
      next();
    } catch (err) {
      next(new Error('توکن نامعتبر یا منقضی شده است'));
    }
  });

  io.on('connection', async (socket) => {
    const { user } = socket;
    socket.join(`user:${user.id}`);

    if (user.roleKey === 'ADMIN' || user.roleKey === 'SUPER_ADMIN') {
      socket.join('role:ADMIN_STAFF');
    }
    if (user.roleKey === 'SELLER') {
      const store = await prisma.store.findUnique({ where: { sellerId: user.id }, select: { id: true } });
      if (store) socket.join(`store:${store.id}`);
    }

    logger.info(`socket connected: user=${user.id} role=${user.roleKey}`);

    socket.on('disconnect', () => {
      logger.info(`socket disconnected: user=${user.id}`);
    });
  });

  return io;
}

function getIo() {
  if (!io) throw new Error('Realtime layer not initialized — call initRealtime(server) first');
  return io;
}

/** Emit to exactly one user's private room. */
function emitToUser(userId, event, payload) {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, payload);
}

/** Emit to every ADMIN/SUPER_ADMIN currently connected (support staff inbox). */
function emitToSupportStaff(event, payload) {
  if (!io) return;
  io.to('role:ADMIN_STAFF').emit(event, payload);
}

/** Emit to the seller who owns a given store. */
function emitToStore(storeId, event, payload) {
  if (!io) return;
  io.to(`store:${storeId}`).emit(event, payload);
}

module.exports = {
  initRealtime, getIo, emitToUser, emitToSupportStaff, emitToStore,
};
