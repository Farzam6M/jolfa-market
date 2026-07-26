const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { generateOrderNumber } = require('../../utils/orderNumber');
const { computeEffectivePrice } = require('../../utils/pricing');
const { getOrCreateCart, SHIPPING_FEE } = require('../cart/cart.service');
const { logAdminActivity } = require('../admin/admin.service');
const { pushNotification } = require('../notifications/notifications.service');
const { PERMISSIONS } = require('../roles/permissions.constants');

const STATUS_LABELS = {
  PENDING: 'در انتظار', CONFIRMED: 'تایید شده', PREPARING: 'در حال آماده‌سازی', SENT: 'ارسال شده', DELIVERED: 'تحویل داده شده', CANCELLED: 'لغو شده',
};

// Explicit state machine: only these transitions are allowed. Prevents an
// admin (or a buggy client) from moving an order backward or skipping steps
// (e.g. PENDING -> DELIVERED, or reviving a CANCELLED/DELIVERED order),
// which would otherwise corrupt order history and stock accounting.
const ORDER_TRANSITIONS = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['SENT', 'CANCELLED'],
  SENT: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

// A seller may only ever move a fulfilment order forward one step at a
// time (Confirmed -> Preparing -> Sent). PENDING (needs admin confirmation
// first), DELIVERED, and CANCELLED are never reachable by a seller — even
// if the request otherwise looks well-formed — because those carry
// payment/refund/customer-facing consequences reserved for admin.
const SELLER_ALLOWED_STATUS_TARGETS = ['PREPARING', 'SENT'];

/**
 * Turns the user's current cart into an Order (+ OrderItems, snapshotting
 * name/price so later product edits never change historical orders),
 * decrements stock, and empties the cart — all inside one transaction so
 * a failure midway never leaves stock or the cart in a half-updated state.
 *
 * Every amount here (subtotal/shippingFee/total, and each item's
 * priceSnapshot) is derived from the product's CURRENT price (and its
 * WholesaleTier, if any, for the ordered qty) read fresh inside the
 * transaction — never from the request body, and never from the cart's own
 * (possibly stale) priceSnapshot — so a client can't pass a discounted total
 * or a forged item price, and a price change after the item was added to
 * the cart is still reflected correctly at checkout.
 */
async function checkout(userId, { addressId }) {
  const cart = await getOrCreateCart(userId);
  if (!cart.items.length) throw ApiError.badRequest('سبد خرید خالی است');

  // IDOR guard: addressId comes straight from the client, so it must be
  // verified to belong to this user before it's ever attached to an order —
  // otherwise a customer could pass another user's address UUID and both
  // ship to it and later read it back (full name/phone/address) via their
  // own order's GET /orders/:id.
  if (addressId) {
    const address = await prisma.address.findUnique({ where: { id: addressId } });
    if (!address || address.userId !== userId) throw ApiError.notFound('آدرس یافت نشد');
  }

  return prisma.$transaction(async (tx) => {
    const pricedItems = [];
    for (const item of cart.items) {
      const product = await tx.product.findUnique({
        where: { id: item.productId },
        include: { wholesaleTiers: true, store: { select: { status: true, seller: { select: { deletedAt: true } } } } },
      });
      if (!product || product.status !== 'APPROVED' || !product.isActive) {
        throw ApiError.badRequest(`محصول «${item.product.name}» دیگر در دسترس نیست`);
      }
      // Re-checked fresh from the DB at the moment of checkout — never trusted
      // from the cart's own (possibly stale) product snapshot — for the same
      // reason prices are recomputed below: a store suspended, or a seller
      // soft-deleted (removeSeller()), after the item was added to the cart
      // must still block the order from being created.
      if (!product.store || product.store.status === 'SUSPENDED' || !product.store.seller || product.store.seller.deletedAt) {
        throw ApiError.badRequest(`محصول «${item.product.name}» دیگر در دسترس نیست`);
      }
      if (product.stock < item.qty) throw ApiError.badRequest(`موجودی «${product.name}» کافی نیست`);
      pricedItems.push({
        productId: item.productId,
        storeId: item.product.storeId,
        nameSnapshot: item.product.name,
        qty: item.qty,
        priceSnapshot: computeEffectivePrice(product, item.qty),
      });
    }

    const subtotal = pricedItems.reduce((s, it) => s + Number(it.priceSnapshot) * it.qty, 0);
    const shippingFee = SHIPPING_FEE;

    const order = await tx.order.create({
      data: {
        orderNumber: generateOrderNumber(),
        userId,
        addressId,
        subtotal,
        shippingFee,
        total: subtotal + shippingFee,
        items: {
          create: pricedItems.map((it) => ({
            productId: it.productId,
            storeId: it.storeId,
            nameSnapshot: it.nameSnapshot,
            priceSnapshot: it.priceSnapshot,
            qty: it.qty,
          })),
        },
      },
      include: { items: true },
    });

    for (const item of cart.items) {
      // Conditional update (stock only decremented if still sufficient) instead of a
      // plain decrement — closes a race window where two concurrent checkouts could
      // both pass the earlier stock check and oversell the same product.
      const { count } = await tx.product.updateMany({
        where: { id: item.productId, stock: { gte: item.qty } },
        data: { stock: { decrement: item.qty } },
      });
      if (count === 0) throw ApiError.badRequest(`موجودی «${item.product.name}» کافی نیست`);
    }
    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

    return order;
  }).then(async (order) => {
    await pushNotification({ icon: 'i-cart', text: `سفارش جدید ${order.orderNumber} ثبت شد`, scope: 'ROLE', targetRole: 'ADMIN' });
    return order;
  });
}

/**
 * Fetches a single order for whoever's asking, scoped by who they are.
 * - Owning customer / admin+ (orders:read:any): full order, unchanged.
 * - Seller whose store has at least one item in this order: allowed
 *   through, but the response is rebuilt from scratch containing ONLY
 *   that seller's own items — never another store's items, never
 *   payment records, never the customer's address. This is what stops a
 *   multi-seller order from leaking one seller's fulfilment details (or
 *   the customer's payment/address info) to another seller who merely
 *   happens to share the same order id.
 * - Everyone else: 403, whether or not the order id exists (an order id
 *   guessed off another store's confirmation email should reveal nothing).
 */
async function getById(orderId, requester) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { product: true, store: true } }, payments: true, address: true },
  });
  if (!order) throw ApiError.notFound('سفارش یافت نشد');

  const isOwner = order.userId === requester.id;
  const isStaff = requester.permissions.includes('*') || requester.permissions.includes(PERMISSIONS.ORDERS_READ_ANY);
  const ownStoreItems = requester.roleKey === 'SELLER'
    ? order.items.filter((it) => it.store.sellerId === requester.id)
    : [];
  const isStoreOwner = ownStoreItems.length > 0;

  if (!isOwner && !isStoreOwner && !isStaff) throw ApiError.forbidden('دسترسی به این سفارش مجاز نیست');

  if (isStoreOwner && !isOwner && !isStaff) {
    // Seller-safe projection — no payments, no address, no other store's items.
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      createdAt: order.createdAt,
      items: ownStoreItems.map((it) => ({
        id: it.id, productId: it.productId, nameSnapshot: it.nameSnapshot, priceSnapshot: it.priceSnapshot, qty: it.qty,
      })),
    };
  }

  return order;
}

/** Full order history for the logged-in customer. */
async function listMine(userId, { page = 1, pageSize = 20 } = {}) {
  const where = { userId };
  const [items, total] = await Promise.all([
    prisma.order.findMany({
      where, include: { items: true }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);
  return {
    items, total, page, pageSize,
  };
}

/** Orders containing at least one item from the seller's own store. Status changes go through updateStatus (which re-checks ownership independently), not this listing. */
async function listForStore(userId, { page = 1, pageSize = 20 } = {}) {
  const store = await prisma.store.findUnique({ where: { sellerId: userId } });
  if (!store) throw ApiError.notFound('فروشگاهی برای این کاربر یافت نشد');

  const where = { items: { some: { storeId: store.id } } };
  const [items, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: { items: { where: { storeId: store.id }, include: { product: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);
  return {
    items, total, page, pageSize,
  };
}

/**
 * Order-status transition. Reachable by two different actors, gated in this
 * service layer (not just the route) so neither path can be bypassed:
 *
 *  - Admin / super_admin (orders:update:status): any order, any legal
 *    transition per ORDER_TRANSITIONS — unchanged from before.
 *  - Seller (orders:update:status:store): only an order containing at
 *    least one of THEIR OWN store's items, only CONFIRMED->PREPARING or
 *    PREPARING->SENT, and only when every item in the order belongs to
 *    their store. The current schema models order status as one value for
 *    the whole order (no per-item/per-store status), so a seller cannot be
 *    allowed to drive a *shared* multi-seller order forward — doing so
 *    would silently mark another store's items "Preparing/Sent" too. Until
 *    that's modeled at the schema level, a multi-seller order's status
 *    stays admin-only; this is the minimal safe behavior rather than a
 *    guess. Everything else (guessing another seller's order id, trying to
 *    reach PENDING/DELIVERED/CANCELLED, changing amounts or payment) is
 *    rejected here regardless of what the route already let through.
 *
 * Cancelling restocks every item inside the same transaction that flips the
 * status, so a cancelled order can never leave stock permanently short.
 */
async function updateStatus(orderId, status, actor) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
  if (!order) throw ApiError.notFound('سفارش یافت نشد');

  const isAdmin = actor.permissions.includes('*') || actor.permissions.includes(PERMISSIONS.ORDERS_UPDATE_STATUS);

  if (!isAdmin) {
    if (actor.roleKey !== 'SELLER' || !actor.permissions.includes(PERMISSIONS.ORDERS_UPDATE_STATUS_STORE)) {
      throw ApiError.forbidden('نقش شما به این عملیات دسترسی ندارد');
    }

    const store = await prisma.store.findUnique({ where: { sellerId: actor.id } });
    const ownsAnItem = !!store && order.items.some((it) => it.storeId === store.id);
    // Same 403 whether the order doesn't exist for this seller at all or
    // exists but belongs to someone else — never lets a guessed order id
    // be confirmed by comparing error responses.
    if (!ownsAnItem) throw ApiError.forbidden('دسترسی به این سفارش مجاز نیست');

    const isSingleSellerOrder = order.items.every((it) => it.storeId === store.id);
    if (!isSingleSellerOrder) {
      throw ApiError.forbidden('این سفارش شامل محصولات چند فروشگاه است؛ تغییر وضعیت آن فقط توسط ادمین انجام می‌شود');
    }

    if (!SELLER_ALLOWED_STATUS_TARGETS.includes(status)) {
      throw ApiError.forbidden('فروشنده اجازه تغییر وضعیت به این حالت را ندارد');
    }
  }

  const allowed = ORDER_TRANSITIONS[order.status] || [];
  if (!allowed.includes(status)) {
    throw ApiError.conflict(`تغییر وضعیت از «${STATUS_LABELS[order.status]}» به «${STATUS_LABELS[status]}» مجاز نیست`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.order.update({ where: { id: orderId }, data: { status } });
    if (status === 'CANCELLED') {
      for (const item of order.items) {
        // eslint-disable-next-line no-await-in-loop
        await tx.product.update({ where: { id: item.productId }, data: { stock: { increment: item.qty } } });
      }
    }
    return result;
  });

  await logAdminActivity(actor.id, `تغییر وضعیت سفارش ${order.orderNumber} به ${STATUS_LABELS[status]}`);
  await pushNotification({
    icon: 'i-truck', text: `وضعیت سفارش ${order.orderNumber} به «${STATUS_LABELS[status]}» تغییر کرد`, scope: 'USER', targetUserId: order.userId,
  });
  return updated;
}

module.exports = {
  checkout, getById, listMine, listForStore, updateStatus, ORDER_TRANSITIONS, SELLER_ALLOWED_STATUS_TARGETS, STATUS_LABELS,
};
