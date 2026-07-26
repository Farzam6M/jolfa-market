/* ============================================================================
   ChatService — هسته مستقل سیستم چت (جلفا مارکت) — نسخه متصل به Backend
   ============================================================================
   API عمومی و امضای متدها دقیقا با نسخه قبلی (localStorage) یکسان است تا
   index.html نیازی به تغییر نداشته باشد.

   - «پشتیبانی» (Customer/Seller ↔ Admin/SuperAdmin): واقعا از REST بک‌اند
     (/api/v1/chat/support...) + WebSocket خوانده/نوشته می‌شود.
   - «چت فروشگاهی» (مشتری ↔ فروشنده): خارج از دامنه این تسک، دست‌نخورده روی
     موتور محلی (localStorage) باقی مانده؛ روت‌های بک‌اند آن از قبل آماده‌اند.
   - اگر بک‌اند/توکن در دسترس نباشد، هر متد پشتیبانی بی‌صدا به موتور محلی
     Fallback می‌کند تا منطق فعلی Frontend هرگز خراب نشود.

   یکپارچه‌سازی بعد از لاگین:
     localStorage.setItem('jm_access_token', accessToken)
     یا: ChatService.configure({ getToken: () => accessToken })
   ============================================================================ */
(function (global) {
  'use strict';

  const CONFIG = {
    apiBaseUrl: global.JOLFA_API_BASE_URL || (global.location.origin + '/api/v1'),
    socketUrl: global.JOLFA_SOCKET_URL || global.location.origin,
    getToken: function () {
      try { return localStorage.getItem('jm_access_token'); } catch (e) { return null; }
    }
  };

  const warnedOnce = Object.create(null);
  function warnFallback(where, err) {
    const key = where + ':' + (err && err.message);
    if (warnedOnce[key]) return;
    warnedOnce[key] = true;
    console.warn('[ChatService] «' + where + '» به بک‌اند وصل نشد، استفاده از حافظه محلی:', err && err.message);
  }

  const StorageAdapter = {
    async getItem(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
    async setItem(key, value) { try { localStorage.setItem(key, value); return true; } catch (e) { return false; } }
  };

  const STORAGE_KEYS = Object.freeze({
    STORE_CONVERSATIONS: 'jolfa_chat_conversations_v2',
    SUPPORT_CONVERSATIONS: 'jolfa_support_conversations_v1'
  });

  function generateId(prefix) { return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
  function nowIso() { return new Date().toISOString(); }
  function createMessage(from, text) { return { id: generateId('msg'), from, bubble: text, time: 'الان', createdAt: nowIso() }; }
  function storeConvKey(storeName, customerId) { return storeName + '::' + customerId; }

  const ChatRepository = {
    async readStoreConversations() {
      const raw = await StorageAdapter.getItem(STORAGE_KEYS.STORE_CONVERSATIONS);
      try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
    },
    async writeStoreConversations(data) { return StorageAdapter.setItem(STORAGE_KEYS.STORE_CONVERSATIONS, JSON.stringify(data)); },
    async readSupportConversations() {
      const raw = await StorageAdapter.getItem(STORAGE_KEYS.SUPPORT_CONVERSATIONS);
      try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
    },
    async writeSupportConversations(data) { return StorageAdapter.setItem(STORAGE_KEYS.SUPPORT_CONVERSATIONS, JSON.stringify(data)); }
  };

  /* ---------- LocalEngine: پیاده‌سازی کامل موتور قبلی (بدون تغییر) ---------- */
  const LocalEngine = {
    async getSupportConversation(userId) {
      if (!userId) return null;
      const all = await ChatRepository.readSupportConversations();
      return all[userId] || null;
    },
    async getAllSupportConversations() {
      const all = await ChatRepository.readSupportConversations();
      return Object.values(all);
    },
    async addSupportMessage(user, text, from) {
      if (!user || !user.id) throw new Error('ChatService.addSupportMessage: کاربر معتبر لازم است');
      if (!text) return null;
      const all = await ChatRepository.readSupportConversations();
      let conv = all[user.id];
      if (!conv) {
        conv = { id: user.id, type: 'support', user_id: user.id, user_name: user.name, user_role: user.role, messages: [], createdAt: nowIso() };
        all[user.id] = conv;
      }
      conv.user_name = user.name;
      conv.user_role = user.role;
      conv.messages.push(createMessage(from || 'user', text));
      conv.updatedAt = nowIso();
      await ChatRepository.writeSupportConversations(all);
      return conv;
    },
    async addSupportReply(userId, text) {
      if (!userId || !text) return null;
      const all = await ChatRepository.readSupportConversations();
      const conv = all[userId];
      if (!conv) return null;
      conv.messages.push(createMessage('support', text));
      conv.updatedAt = nowIso();
      await ChatRepository.writeSupportConversations(all);
      return conv;
    },
    async getStoreConversation(storeName, customerId) {
      if (!storeName || !customerId) return null;
      const all = await ChatRepository.readStoreConversations();
      return all[storeConvKey(storeName, customerId)] || null;
    },
    async getMyStoreConversations(customerId) {
      if (!customerId) return [];
      const all = await ChatRepository.readStoreConversations();
      return Object.values(all).filter(c => c.customerId === customerId);
    },
    async getSellerConversations(storeName) {
      if (!storeName) return [];
      const all = await ChatRepository.readStoreConversations();
      return Object.values(all).filter(c => c.storeName === storeName)
        .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
    },
    async addStoreMessage(storeName, customerId, customerName, text, from) {
      if (!storeName || !customerId || !text) return null;
      const all = await ChatRepository.readStoreConversations();
      const key = storeConvKey(storeName, customerId);
      let conv = all[key];
      const isNew = !conv;
      if (!conv) { conv = { id: key, type: 'store', storeName, customerId, customerName, messages: [], createdAt: nowIso() }; all[key] = conv; }
      if (customerName) conv.customerName = customerName;
      conv.messages.push(createMessage(from, text));
      conv.updatedAt = nowIso();
      await ChatRepository.writeStoreConversations(all);
      return { isNew, conversation: conv, messages: conv.messages };
    },
    async markStoreConversationRead(storeName, customerId, viewer) {
      if (!storeName || !customerId || (viewer !== 'customer' && viewer !== 'store')) return null;
      const all = await ChatRepository.readStoreConversations();
      const conv = all[storeConvKey(storeName, customerId)];
      if (!conv) return null;
      if (viewer === 'customer') conv.customerReadAt = nowIso(); else conv.storeReadAt = nowIso();
      await ChatRepository.writeStoreConversations(all);
      return conv;
    },
    async markSupportReadByAdmin(userId) {
      if (!userId) return null;
      const all = await ChatRepository.readSupportConversations();
      const conv = all[userId];
      if (!conv) return null;
      conv.adminReadAt = nowIso();
      await ChatRepository.writeSupportConversations(all);
      return conv;
    },
    async markSupportReadByUser(userId) {
      if (!userId) return null;
      const all = await ChatRepository.readSupportConversations();
      const conv = all[userId];
      if (!conv) return null;
      conv.userReadAt = nowIso();
      await ChatRepository.writeSupportConversations(all);
      return conv;
    }
  };

  function pureStoreUnreadCount(conv, viewer) {
    if (!conv || !conv.messages || !conv.messages.length) return 0;
    const fromWanted = viewer === 'customer' ? 'store' : 'customer';
    const readAtField = viewer === 'customer' ? 'customerReadAt' : 'storeReadAt';
    const readAt = conv[readAtField] ? new Date(conv[readAtField]).getTime() : 0;
    return conv.messages.filter(m => m.from === fromWanted && new Date(m.createdAt).getTime() > readAt).length;
  }
  function pureSupportUnreadCount(conv) {
    if (!conv || !conv.messages || !conv.messages.length) return 0;
    const readAt = conv.adminReadAt ? new Date(conv.adminReadAt).getTime() : 0;
    return conv.messages.filter(m => m.from === 'user' && new Date(m.createdAt).getTime() > readAt).length;
  }
  function pureSupportUnreadCountForUser(conv) {
    if (!conv || !conv.messages || !conv.messages.length) return 0;
    const readAt = conv.userReadAt ? new Date(conv.userReadAt).getTime() : 0;
    return conv.messages.filter(m => m.from === 'support' && new Date(m.createdAt).getTime() > readAt).length;
  }

  /* ---------- HTTP Adapter: فقط برای پشتیبانی ---------- */
  async function apiFetch(path, options) {
    options = options || {};
    const token = CONFIG.getToken();
    if (!token) { const e = new Error('بدون توکن'); e.code = 'NO_AUTH_TOKEN'; throw e; }
    let res;
    try {
      res = await fetch(CONFIG.apiBaseUrl + path, {
        method: options.method || 'GET',
        headers: Object.assign({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, options.headers || {}),
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined
      });
    } catch (networkErr) {
      const e = new Error('اتصال به سرور برقرار نشد'); e.code = 'NETWORK_ERROR'; throw e;
    }
    let json = null;
    try { json = await res.json(); } catch (e) { /* noop */ }
    if (!res.ok) { const e = new Error((json && json.message) || ('HTTP ' + res.status)); e.status = res.status; throw e; }
    return json ? json.data : null;
  }

  function mapRole(roleKey) { return roleKey ? String(roleKey).toLowerCase() : ''; }
  function mapSupportMessage(m) {
    return { id: m.id, from: m.from === 'USER' ? 'user' : 'support', bubble: m.body, time: 'الان', createdAt: m.createdAt, read: !!m.read };
  }
  function mapSupportConversation(c) {
    if (!c) return null;
    return {
      id: c.id, type: 'support', user_id: c.userId,
      user_name: c.user ? c.user.name : '',
      user_role: (c.user && c.user.role) ? mapRole(c.user.role.key) : '',
      messages: (c.messages || []).map(mapSupportMessage),
      createdAt: c.createdAt, updatedAt: c.updatedAt,
      userReadAt: c.userReadAt, adminReadAt: c.adminReadAt, unread: c.unread
    };
  }

  const RemoteSupport = {
    async getConversation(userId) {
      try {
        const data = await apiFetch('/chat/support/' + encodeURIComponent(userId));
        return mapSupportConversation(data);
      } catch (err) {
        if (err.status === 403) { const data = await apiFetch('/chat/support'); return mapSupportConversation(data); }
        throw err;
      }
    },
    async getAllConversations() {
      const data = await apiFetch('/chat/support/all');
      return (data || []).map(mapSupportConversation);
    },
    async addMessageAsUser(userId, text) {
      await apiFetch('/chat/support', { method: 'POST', body: { body: text } });
      return this.getConversation(userId);
    },
    async addReplyAsAdmin(userId, text) {
      await apiFetch('/chat/support/' + encodeURIComponent(userId) + '/reply', { method: 'POST', body: { body: text } });
      return this.getConversation(userId);
    },
    async markReadByUser() { return apiFetch('/chat/support/read', { method: 'POST' }); },
    async markReadByAdmin(userId) { return apiFetch('/chat/support/' + encodeURIComponent(userId) + '/read', { method: 'POST' }); }
  };

  /* ---------- WebSocket (Socket.io) — آماده برای Real-time ---------- */
  let socket = null;
  let socketBoundToken = null; // token the current `socket` was opened with — used to detect a stale connection after login/logout
  const externalChangeListeners = [];
  let storageListenerAttached = false; // guards against attaching the window 'storage' listener more than once

  function teardownSocket() {
    if (!socket) return;
    try {
      // remove our own handlers before disconnecting so a late/queued event
      // from the closing connection can never reach externalChangeListeners
      // (which would otherwise leak the previous user's chat activity to
      // whichever screen happens to be mounted next).
      socket.off('chat:support:message');
      socket.off('chat:store:message');
      socket.off('connect_error');
      socket.disconnect();
    } catch (e) { /* noop */ }
    socket = null;
    socketBoundToken = null;
  }

  function ensureSocket(forceReconnect) {
    if (typeof global.io !== 'function') return null;
    const token = CONFIG.getToken();
    if (!token) { teardownSocket(); return null; }
    // A previously-open socket authenticated with a DIFFERENT token (i.e. a
    // different user logged in since) is stale and must never be reused,
    // even if the caller didn't explicitly ask for forceReconnect.
    if (socket && (forceReconnect || socketBoundToken !== token)) teardownSocket();
    if (socket) return socket;
    socket = global.io(CONFIG.socketUrl, { path: '/socket.io', auth: { token: token }, transports: ['websocket', 'polling'], reconnection: true });
    socketBoundToken = token;
    socket.on('chat:support:message', function () { externalChangeListeners.forEach(function (cb) { cb('support'); }); });
    socket.on('chat:store:message', function () { externalChangeListeners.forEach(function (cb) { cb('store'); }); });
    socket.on('connect_error', function (err) { warnFallback('websocket', err); });
    return socket;
  }

  /* ---------- ChatService: همان API عمومی قبلی ---------- */
  const ChatService = {
    configure(opts) { if (!opts) return; Object.assign(CONFIG, opts); ensureSocket(true); },

    async getSupportConversation(userId) {
      if (!userId) return null;
      try { return await RemoteSupport.getConversation(userId); }
      catch (err) { warnFallback('getSupportConversation', err); return LocalEngine.getSupportConversation(userId); }
    },
    async getAllSupportConversations() {
      try { return await RemoteSupport.getAllConversations(); }
      catch (err) { warnFallback('getAllSupportConversations', err); return LocalEngine.getAllSupportConversations(); }
    },
    async addSupportMessage(user, text, from) {
      if (!user || !user.id) throw new Error('ChatService.addSupportMessage: کاربر معتبر لازم است');
      if (!text) return null;
      try { return await RemoteSupport.addMessageAsUser(user.id, text); }
      catch (err) { warnFallback('addSupportMessage', err); return LocalEngine.addSupportMessage(user, text, from); }
    },
    async addSupportReply(userId, text) {
      if (!userId || !text) return null;
      try { return await RemoteSupport.addReplyAsAdmin(userId, text); }
      catch (err) { warnFallback('addSupportReply', err); return LocalEngine.addSupportReply(userId, text); }
    },
    async markSupportReadByAdmin(userId) {
      if (!userId) return null;
      try { return await RemoteSupport.markReadByAdmin(userId); }
      catch (err) { warnFallback('markSupportReadByAdmin', err); return LocalEngine.markSupportReadByAdmin(userId); }
    },
    getSupportUnreadCount(conv) { return pureSupportUnreadCount(conv); },
    async markSupportReadByUser(userId) {
      if (!userId) return null;
      try { return await RemoteSupport.markReadByUser(); }
      catch (err) { warnFallback('markSupportReadByUser', err); return LocalEngine.markSupportReadByUser(userId); }
    },
    getSupportUnreadCountForUser(conv) { return pureSupportUnreadCountForUser(conv); },

    async getStoreConversation(storeName, customerId) { return LocalEngine.getStoreConversation(storeName, customerId); },
    async getMyStoreConversations(customerId) { return LocalEngine.getMyStoreConversations(customerId); },
    async getSellerConversations(storeName) { return LocalEngine.getSellerConversations(storeName); },
    async addStoreMessage(storeName, customerId, customerName, text, from) { return LocalEngine.addStoreMessage(storeName, customerId, customerName, text, from); },
    async markStoreConversationRead(storeName, customerId, viewer) { return LocalEngine.markStoreConversationRead(storeName, customerId, viewer); },
    getStoreUnreadCount(conv, viewer) { return pureStoreUnreadCount(conv, viewer); },

    onExternalChange(callback) {
      externalChangeListeners.push(callback);
      if (!storageListenerAttached) {
        storageListenerAttached = true;
        global.addEventListener('storage', function (e) {
          if (e.key === STORAGE_KEYS.STORE_CONVERSATIONS) externalChangeListeners.forEach(function (cb) { cb('store'); });
          else if (e.key === STORAGE_KEYS.SUPPORT_CONVERSATIONS) externalChangeListeners.forEach(function (cb) { cb('support'); });
        });
      }
      ensureSocket();
    },

    /* باید در doLogout() صدا زده شود. بدون این متد، سوکت کاربر قبلی متصل
       می‌ماند و eventهایی که هنوز در پرواز بودند می‌توانستند به صفحهٔ
       کاربر بعدی که در همان تب لاگین می‌کند درز کنند.
       توجه: عمداً externalChangeListeners را پاک نمی‌کند — آن listener
       یک‌بار در بارگذاری صفحه (نه به‌ازای هر لاگین) ثبت می‌شود و منطق آن
       کاملاً عمومی/بدون وابستگی به کاربر خاص است (هر بار state فعلی را از
       DOM/متغیرهای global می‌خواند)؛ پاک کردنش یعنی کاربر بعدی که در همان
       تب لاگین می‌کند دیگر هیچ به‌روزرسانی real-time دریافت نمی‌کند. */
    logout() {
      teardownSocket();
    }
  };

  global.ChatService = ChatService;
})(window);
