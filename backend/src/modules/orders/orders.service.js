const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { generateOrderNumber } = require('../../utils/orderNumber');
const { computeEffectivePrice } = require('../../utils/pricing');
const { getOrCreateCart, SHIPPING_FEE } = require('../cart/cart.service');
const { logAdminActivity } = require('../admin/admin.service');
const { pushNotification } = require('../notifications/notifications.service');
const { PERMISSIONS } = require('../roles/permissions.constants');
const { resolveCommissionRate } = require('../commission-rules/commission-rules.service');

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
 * Order-safe identity view of the StoreProduct behind an OrderItem.
 *
 * Deliberately excludes price, compareAtPrice, stock, discount, warranty,
 * shippingTime, status, and isActive — those live on the *mutable*
 * StoreProduct and can be edited by the seller at any time after the sale.
 * The only purchase-time facts an order is allowed to show are the ones
 * frozen at checkout (OrderItem.nameSnapshot/priceSnapshot/qty); this view
 * exists only to show stable catalog identity (what item this was), never
 * today's commercial terms. (Reusing products.service.js's flattenStoreProduct
 * here — as a prior version of this function did — would leak exactly that
 * live data into order history, which is the bug this function fixes.)
 */
function orderItemProductIdentity(storeProduct) {
  if (!storeProduct) return storeProduct;
  const { product } = storeProduct;
  return {
    id: storeProduct.id,
    productId: storeProduct.productId,
    name: product?.name,
    brand: product?.brand,
    model: product?.model,
    capacity: product?.capacity,
    color: product?.color,
    slug: product?.slug,
  };
}

/** Flattens an OrderItem's nested storeProduct back to the pre-split productId/product shape, using the order-safe identity view above (never live pricing/inventory). */
function flattenOrderItem(it) {
  const { storeProduct, ...rest } = it;
  return {
    ...rest,
    productId: it.storeProductId,
    ...(storeProduct ? { product: orderItemProductIdentity(storeProduct) } : {}),
  };
}

/**
 * Turns the user's current cart into an Order (+ OrderItems, snapshotting
 * name/price so later product edits never change historical orders),
 * decrements stock, and empties the cart — all inside one transaction so
 * a failure midway never leaves stock or the cart in a half-updated state.
 *
 * A cart/order line item is a specific STORE's offer (StoreProduct) — price
 * and stock are per-store, not on the shared global Product (see
 * products.service.js for the Product/StoreProduct split).
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
      const storeProduct = await tx.storeProduct.findUnique({
        where: { id: item.storeProductId },
        include: { wholesaleTiers: true, product: true, store: { select: { status: true, seller: { select: { deletedAt: true } } } } },
      });
      if (!storeProduct || storeProduct.status !== 'APPROVED' || !storeProduct.isActive) {
        throw ApiError.badRequest(`محصول «${item.storeProduct.product.name}» دیگر در دسترس نیست`);
      }
      // Re-checked fresh from the DB at the moment of checkout — never trusted
      // from the cart's own (possibly stale) product snapshot — for the same
      // reason prices are recomputed below: a store suspended, or a seller
      // soft-deleted (removeSeller()), after the item was added to the cart
      // must still block the order from being created.
      if (!storeProduct.store || storeProduct.store.status === 'SUSPENDED' || !storeProduct.store.seller || storeProduct.store.seller.deletedAt) {
        throw ApiError.badRequest(`محصول «${item.storeProduct.product.name}» دیگر در دسترس نیست`);
      }
      if (storeProduct.stock < item.qty) throw ApiError.badRequest(`موجودی «${storeProduct.product.name}» کافی نیست`);
      pricedItems.push({
        storeProductId: item.storeProductId,
        storeId: item.storeProduct.storeId,
        nameSnapshot: item.storeProduct.product.name,
        qty: item.qty,
        priceSnapshot: computeEffectivePrice(storeProduct, item.qty),
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
            storeProductId: it.storeProductId,
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
      const { count } = await tx.storeProduct.updateMany({
        where: { id: item.storeProductId, stock: { gte: item.qty } },
        data: { stock: { decrement: item.qty } },
      });
      if (count === 0) throw ApiError.badRequest(`موجودی «${item.storeProduct.product.name}» کافی نیست`);
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
    include: { items: { include: { storeProduct: { include: { product: true } }, store: true } }, payments: true, address: true },
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
        id: it.id, productId: it.storeProductId, nameSnapshot: it.nameSnapshot, priceSnapshot: it.priceSnapshot, qty: it.qty,
      })),
    };
  }

  return { ...order, items: order.items.map(flattenOrderItem) };
}

/** Full order history for the logged-in customer. */
async function listMine(userId, { page = 1, pageSize = 20 } = {}) {
  const where = { userId };
  const [rawItems, total] = await Promise.all([
    prisma.order.findMany({
      where, include: { items: true }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);
  // items here carry only the point-in-time snapshot (nameSnapshot/priceSnapshot),
  // no live product join — just alias storeProductId -> productId for API compatibility.
  const items = rawItems.map((order) => ({
    ...order,
    items: order.items.map((it) => ({ ...it, productId: it.storeProductId })),
  }));
  return {
    items, total, page, pageSize,
  };
}

/** Orders containing at least one item from the seller's own store. Status changes go through updateStatus (which re-checks ownership independently), not this listing. */
async function listForStore(userId, { page = 1, pageSize = 20 } = {}) {
  const store = await prisma.store.findUnique({ where: { sellerId: userId } });
  if (!store) throw ApiError.notFound('فروشگاهی برای این کاربر یافت نشد');

  const where = { items: { some: { storeId: store.id } } };
  const [rawItems, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: { items: { where: { storeId: store.id }, include: { storeProduct: { include: { product: true } } } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);
  const items = rawItems.map((order) => ({ ...order, items: order.items.map(flattenOrderItem) }));
  return {
    items, total, page, pageSize,
  };
}

/**
 * Settlement history for the logged-in seller's own store — Phase 3 (Seller
 * Settlement Visibility). Reuses the same store-ownership lookup as
 * listForStore, then reads OrderItemSettlement directly (rather than
 * deriving it from OrderItem/CommissionRule) since settlement rows are
 * already the point-in-time snapshot of what was actually paid out — see
 * settleDeliveredOrder below and the "Historical snapshot" note there.
 * Scoped to `storeId: store.id` at the query level, so a seller can never
 * see another store's settlements no matter what query params are sent.
 */
async function listSettlementsForStore(userId, { page = 1, pageSize = 20 } = {}) {
  const store = await prisma.store.findUnique({ where: { sellerId: userId } });
  if (!store) throw ApiError.notFound('فروشگاهی برای این کاربر یافت نشد');

  const where = { storeId: store.id };
  const [items, total] = await Promise.all([
    prisma.orderItemSettlement.findMany({
      where,
      include: {
        order: { select: { id: true, orderNumber: true } },
        orderItem: { select: { id: true, nameSnapshot: true, priceSnapshot: true, qty: true } },
        commissionRule: { select: { id: true, scope: true } },
      },
      orderBy: { settledAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.orderItemSettlement.count({ where }),
  ]);
  return {
    items, total, page, pageSize,
  };
}

/**
 * Settles seller earnings for a DELIVERED order: creates exactly one
 * OrderItemSettlement row per OrderItem (a commission snapshot + the
 * seller's net earning) and credits each seller's wallet with that
 * earning. Called by updateStatus INSIDE the same `tx` that performs the
 * SENT -> DELIVERED claim, so a failure anywhere in here rolls back the
 * status change too — the order is left on SENT, safely retryable, and no
 * wallet is left half-credited.
 *
 * Per item:
 *   gross          = priceSnapshot * qty
 *   commissionRate = resolveCommissionRate(item.storeId, product.categoryId) at
 *                    settlement time (CAMPAIGN > SELLER > CATEGORY > GLOBAL,
 *                    see commission-rules.service.js)
 *   commission     = round(gross * commissionRate / 100)
 *   sellerEarning  = gross - commission
 *
 * commissionRate/gross/commission/sellerEarning are written as a point-in-time
 * SNAPSHOT on OrderItemSettlement — a CommissionRule edited or deactivated
 * afterwards can never change a past settlement's numbers.
 *
 * Idempotency: OrderItemSettlement.orderItemId is DB-@unique, so even if
 * this were ever invoked twice for the same item (it shouldn't be — the
 * caller's atomic SENT->DELIVERED claim already prevents that), the second
 * tx.orderItemSettlement.create() would violate the unique constraint and
 * throw, rolling back the whole transaction rather than double-crediting a
 * seller's wallet. The wallet credit itself also uses an atomic
 * conditional updateMany (mirrors the debit pattern in
 * payments.service.js#payWithWallet) rather than a read-then-write, so it
 * can't race with any other balance-mutating operation on the same wallet.
 */
async function settleDeliveredOrder(tx, order) {
  // eslint-disable-next-line no-restricted-syntax
  for (const item of order.items) {
    // eslint-disable-next-line no-await-in-loop
    const storeProduct = await tx.storeProduct.findUnique({
      where: { id: item.storeProductId },
      select: { product: { select: { categoryId: true } } },
    });
    const categoryId = storeProduct?.product?.categoryId || null;

    // eslint-disable-next-line no-await-in-loop
    const { rule, rate } = await resolveCommissionRate(item.storeId, categoryId);

    const gross = Number(item.priceSnapshot) * item.qty;
    const commission = Math.round((gross * Number(rate)) / 100);
    const sellerEarning = gross - commission;

    // eslint-disable-next-line no-await-in-loop
    await tx.orderItemSettlement.create({
      data: {
        orderItemId: item.id,
        orderId: order.id,
        storeId: item.storeId,
        commissionRate: rate,
        grossAmount: gross,
        commissionAmount: commission,
        sellerEarning,
        commissionRuleId: rule.id,
      },
    });

    // eslint-disable-next-line no-await-in-loop
    const store = await tx.store.findUnique({ where: { id: item.storeId }, select: { sellerId: true } });

    // Atomic credit — same compare-and-swap-free-but-conditional pattern as
    // the debit in payments.service.js#payWithWallet, just in the other
    // direction. A missing wallet (should be impossible — every user gets
    // one at registration, see auth.service.js/users.service.js/
    // stores.service.js) surfaces as count !== 1 and throws, rolling back
    // this whole settlement rather than silently dropping the seller's
    // earning.
    // eslint-disable-next-line no-await-in-loop
    const credited = await tx.wallet.updateMany({
      where: { userId: store.sellerId },
      data: { balance: { increment: sellerEarning } },
    });
    if (credited.count !== 1) {
      throw ApiError.internal('کیف پول فروشنده برای تسویه یافت نشد');
    }

    // eslint-disable-next-line no-await-in-loop
    const wallet = await tx.wallet.findUnique({ where: { userId: store.sellerId } });
    // eslint-disable-next-line no-await-in-loop
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'CREDIT',
        amount: sellerEarning,
        reason: `تسویه سفارش ${order.orderNumber}`,
        refId: item.id,
      },
    });
  }
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

  let settled = true; // stays true (=> run the side-effects below) for every non-DELIVERED transition, exactly as before.

  const updated = await prisma.$transaction(async (tx) => {
    if (status === 'DELIVERED') {
      // Atomic claim: order flips SENT -> DELIVERED only if it is STILL
      // SENT right now, inside this transaction — deliberately re-checked
      // here rather than trusting `order.status` (read from `order` above,
      // BEFORE this transaction started and therefore possibly stale). Two
      // concurrent DELIVERED requests for the same order (double click,
      // retried webhook, etc.) can otherwise both pass the ORDER_TRANSITIONS
      // check above and both attempt to settle — this makes "is it still
      // SENT" and "flip it to DELIVERED" one atomic DB operation, the same
      // compare-and-swap pattern used for stock (checkout) and payments
      // (payWithWallet/payCashOnDelivery claiming PENDING->CONFIRMED).
      const claimed = await tx.order.updateMany({ where: { id: orderId, status: 'SENT' }, data: { status } });
      if (claimed.count === 0) {
        // Lost the race to a concurrent request that already delivered
        // this order. Graceful no-op: do NOT settle again and do NOT
        // credit any seller's wallet a second time — just report back
        // whatever the order's status actually is now.
        settled = false;
        return tx.order.findUnique({ where: { id: orderId } });
      }
      // Settlement runs in the SAME transaction as the claim above: if any
      // part of it fails (missing wallet, commission resolution error,
      // etc.) the whole transaction — including the SENT->DELIVERED flip
      // itself — rolls back, leaving the order on SENT so this call can be
      // safely retried instead of getting stuck half-delivered/half-settled.
      await settleDeliveredOrder(tx, { ...order, status });
      return tx.order.findUnique({ where: { id: orderId } });
    }

    const result = await tx.order.update({ where: { id: orderId }, data: { status } });
    if (status === 'CANCELLED') {
      for (const item of order.items) {
        // eslint-disable-next-line no-await-in-loop
        await tx.storeProduct.update({ where: { id: item.storeProductId }, data: { stock: { increment: item.qty } } });
      }
    }
    return result;
  });

  if (settled) {
    await logAdminActivity(actor.id, `تغییر وضعیت سفارش ${order.orderNumber} به ${STATUS_LABELS[status]}`);
    await pushNotification({
      icon: 'i-truck', text: `وضعیت سفارش ${order.orderNumber} به «${STATUS_LABELS[status]}» تغییر کرد`, scope: 'USER', targetUserId: order.userId,
    });
  }
  return updated;
}

module.exports = {
  checkout, getById, listMine, listForStore, listSettlementsForStore, updateStatus, ORDER_TRANSITIONS, SELLER_ALLOWED_STATUS_TARGETS, STATUS_LABELS,
};
