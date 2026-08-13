const crypto = require('crypto');
const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { generateOrderNumber } = require('../../utils/orderNumber');
const { computeEffectivePrice } = require('../../utils/pricing');
const { getOrCreateCart, SHIPPING_FEE } = require('../cart/cart.service');
const { logAdminActivity } = require('../admin/admin.service');
const { pushNotification } = require('../notifications/notifications.service');
const { PERMISSIONS } = require('../roles/permissions.constants');
const { resolveCommissionRate } = require('../commission-rules/commission-rules.service');
const { refundWallet, refundGateway } = require('../payments/payments.service');
const { recoverSellerLiabilities } = require('../payout-liabilities/payout-liabilities.service');
const {
  postSettlement, postRefund, postPaymentReversed,
} = require('../ledger/ledger.service');

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
    // Cart-level checkout claim (F1): `Cart.userId` is unique, so this user
    // has exactly one cart row — it already IS the stable identity a
    // checkout operation is "for". Locking that single row here (a real
    // Postgres row lock, not an in-process mutex) means a second checkout
    // request for the SAME cart — whether truly concurrent or a client
    // retry that overlaps a still-in-flight first request — blocks on this
    // statement until the first request's transaction commits or rolls
    // back, instead of racing it past the checks below. Because the lock is
    // scoped to this one cart row, two different users (different cart
    // rows) are never serialized against each other by this, even if they
    // happen to be buying the same product.
    await tx.$queryRaw`SELECT id FROM "carts" WHERE id = ${cart.id} FOR UPDATE`;

    // Re-check under the lock whether this cart still has items to check
    // out. If it doesn't — even though it did in the guard above, moments
    // ago — a concurrent checkout for this exact cart just finished (and
    // emptied it) while we were waiting for the lock: that's the duplicate
    // checkout attempt this claim exists to stop, so surface it as a clean
    // conflict rather than silently creating a second Order.
    const stillPending = await tx.cartItem.count({ where: { cartId: cart.id } });
    if (stillPending === 0) {
      throw ApiError.conflict('این سبد خرید توسط یک درخواست هم‌زمان دیگر هم‌اکنون تسویه شد');
    }

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

  // Refund history — owner/staff only (never sent through the seller-safe
  // projection above), same as payments/address. A cancellation refund or a
  // delivered-order refund both produce PaymentRefund rows here.
  const refunds = await prisma.paymentRefund.findMany({
    where: { orderId },
    include: { reversals: true },
    orderBy: { createdAt: 'desc' },
  });

  return {
    ...order, items: order.items.map(flattenOrderItem), refunds,
  };
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
 *
 * Phase 6 — liability recovery: BEFORE the wallet credit, `sellerEarning`
 * is run through payout-liabilities.service.js#recoverSellerLiabilities
 * (in this same `tx`), which FIFO-recovers as much as possible against
 * the seller's OUTSTANDING SellerPayoutLiability rows and returns
 * whatever remains. Only that remainder is credited to the wallet — the
 * gross `sellerEarning` itself, and everything computed from it
 * (OrderItemSettlement's snapshot, commission), is completely unchanged;
 * only how much of it reaches the wallet differs. For a seller with no
 * outstanding liability this is a no-op (remainder === sellerEarning),
 * so this function's behavior for such sellers is unchanged from before
 * Phase 6.
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
    const settlement = await tx.orderItemSettlement.create({
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

    // Ledger — SETTLEMENT: posted with the FULL, original sellerEarning
    // (never remainingSellerEarning) — liability recovery below is an
    // independent Ledger event with its own Journal, not folded into this
    // one. eventId = OrderItemSettlement.id, same transaction.
    // eslint-disable-next-line no-await-in-loop
    await postSettlement(tx, {
      eventId: settlement.id,
      actorId: null,
      sellerId: store.sellerId,
      grossAmount: gross,
      commissionAmount: commission,
      sellerEarning,
    });

    // Phase 6: recover as much of this earning as possible against the
    // seller's OUTSTANDING liabilities (FIFO) BEFORE crediting anything —
    // see recoverSellerLiabilities' own comment for why this happens
    // first rather than crediting the gross amount and debiting after
    // (avoids a temporary wallet inflation that was never really
    // available to the seller). No-op (remainingSellerEarning ===
    // sellerEarning) when the seller has no outstanding liability.
    // eslint-disable-next-line no-await-in-loop
    const { remainingSellerEarning } = await recoverSellerLiabilities(tx, store.sellerId, sellerEarning, settlement.id);

    // Atomic credit — same compare-and-swap-free-but-conditional pattern as
    // the debit in payments.service.js#payWithWallet, just in the other
    // direction. A missing wallet (should be impossible — every user gets
    // one at registration, see auth.service.js/users.service.js/
    // stores.service.js) surfaces as count !== 1 and throws, rolling back
    // this whole settlement rather than silently dropping the seller's
    // earning. Still run even when remainingSellerEarning is 0 (increment
    // by 0) so the "wallet exists" invariant check below stays identical
    // to pre-Phase-6 behavior for every seller, liability or not.
    // eslint-disable-next-line no-await-in-loop
    const credited = await tx.wallet.updateMany({
      where: { userId: store.sellerId },
      data: { balance: { increment: remainingSellerEarning } },
    });
    if (credited.count !== 1) {
      throw ApiError.internal('کیف پول فروشنده برای تسویه یافت نشد');
    }

    // Only record a CREDIT WalletTransaction when money actually reached
    // the wallet — a fully-recovered earning (remainder 0) already has
    // its own audit trail via recoverSellerLiabilities' DEBIT row(s), so
    // a zero-amount CREDIT here would be pure noise, not a real event.
    if (remainingSellerEarning > 0) {
      // eslint-disable-next-line no-await-in-loop
      const wallet = await tx.wallet.findUnique({ where: { userId: store.sellerId } });
      // eslint-disable-next-line no-await-in-loop
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'CREDIT',
          amount: remainingSellerEarning,
          reason: `تسویه سفارش ${order.orderNumber}`,
          refId: item.id,
        },
      });
    }
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
  // `payments` included here (in addition to `items`) so a CANCELLED
  // transition can look for a SUCCESS payment to refund — see the
  // Phase 4 refund block below.
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true, payments: true } });
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

      // Pre-delivery cancellation refund (Phase 4). Only a payment that
      // actually SUCCEEDED needs reversing:
      //   - COD is never SUCCESS at this point in the flow (see
      //     payments.service.js#payCashOnDelivery — nothing in this
      //     codebase ever marks a COD payment SUCCESS before delivery), so
      //     it naturally falls through with no refund, matching the
      //     "COD was never charged" rule.
      //   - WALLET is refunded immediately (money lives entirely in this
      //     app).
      //   - GATEWAY only gets a REQUESTED PaymentRefund — no gateway API
      //     is ever called; an admin confirms the real reversal later via
      //     PATCH /admin/payment-refunds/:id/mark-processed.
      // idempotencyKey is deterministic per-payment (not random) so that
      // if this exact transition were ever retried, the refund functions'
      // own idempotency guard (PaymentRefund.idempotencyKey @unique) makes
      // the retry a no-op instead of a second refund.
      const succeededPayment = order.payments.find((p) => p.status === 'SUCCESS');
      if (succeededPayment) {
        const idempotencyKey = `cancel-refund:${succeededPayment.id}`;
        if (succeededPayment.method === 'WALLET') {
          const refund = await refundWallet(succeededPayment.id, succeededPayment.amount, idempotencyKey, actor, 'PRE_DELIVERY_CANCELLATION', tx);
          // Ledger — PAYMENT_REVERSED (WALLET): posted immediately, in the
          // SAME transaction as refundWallet's own wallet credit above —
          // unlike a GATEWAY reversal, a WALLET refund's money movement is
          // real and immediate, so there is nothing to defer to (mirrors
          // payWithWallet's own immediate PAYMENT_CONFIRMED posting).
          // postJournal's own (eventType, eventId) idempotency makes this
          // safe to call again on an idempotent-replay retry of this same
          // transition; the ledgerStatus update below is likewise a no-op
          // once already 'POSTED'.
          await postPaymentReversed(tx, {
            eventId: succeededPayment.id,
            actorId: null,
            method: 'WALLET',
            customerId: order.userId,
            amount: succeededPayment.amount,
          });
          await tx.paymentRefund.update({ where: { id: refund.id }, data: { ledgerStatus: 'POSTED' } });
        } else if (succeededPayment.method === 'GATEWAY') {
          // GATEWAY reversal is deliberately NOT posted here — no real
          // gateway reversal has happened yet (refundGateway only records a
          // REQUESTED PaymentRefund). The Ledger PAYMENT_REVERSED journal is
          // posted only once an admin actually confirms it via
          // markGatewayRefundProcessed's Case C.
          await refundGateway(succeededPayment.id, succeededPayment.amount, idempotencyKey, actor, 'PRE_DELIVERY_CANCELLATION', tx);
        }
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

/**
 * Refunds part or all of a DELIVERED order's items (Phase 4). Admin-only
 * (ORDERS_REFUND, enforced at the route). Does NOT touch OrderStatus — a
 * refunded order stays DELIVERED forever; the refund lives entirely in
 * PaymentRefund + OrderItemSettlementReversal rows layered on top.
 *
 * `items` is [{ orderItemId, qty }, ...] — full or partial per item, and
 * this function may be called multiple times for the same order (multiple
 * partial refunds) as long as the cumulative refunded qty per item never
 * exceeds that item's original OrderItem.qty.
 *
 * Per requested item, using the ORIGINAL settlement's snapshot (never the
 * live CommissionRule):
 *   refundedGrossAmount      = OrderItem.priceSnapshot * qty
 *   refundedCommissionAmount = round(refundedGrossAmount * settlement.commissionRate / 100)
 *   refundedSellerEarning    = refundedGrossAmount - refundedCommissionAmount
 * This mirrors settleDeliveredOrder's own formula exactly (same rate,
 * same rounding), just run backwards for the returned quantity. The
 * OrderItemSettlement row itself is only ever read here, never written.
 *
 * Wallet clawback is all-or-nothing only in the sense that this whole
 * $transaction is: every affected store's seller wallet is debited by an
 * atomic conditional updateMany (balance: {gte: amount}), the same
 * compare-and-swap pattern used everywhere else in this codebase for
 * wallet mutations (payWithWallet's debit, settleDeliveredOrder's credit).
 * Unlike a plain money mutation though, the CUSTOMER refund is not allowed
 * to fail just because a seller's wallet can no longer cover the full
 * clawback (e.g. the seller already withdrew it via a PayoutRequest) — see
 * SellerPayoutLiability's model comment. So when the full-amount debit
 * misses, this collects whatever the wallet currently holds (down to, but
 * never below, zero) and records the uncollected remainder as an additive
 * SellerPayoutLiability row instead of throwing. Any OTHER kind of failure
 * (bad line, over-refund, a genuine concurrent-modification race caught by
 * Serializable) still throws and rolls back the whole transaction — no
 * partial refund is ever left behind for those cases.
 *
 * Runs at Serializable isolation specifically so that two concurrent
 * refund requests against the SAME item (which each read
 * "already-refunded qty so far" via a plain aggregate, not a single-row
 * compare-and-swap) can never both pass the over-refund check and jointly
 * refund more than the item's original qty — Postgres aborts the loser
 * with a serialization failure instead, which surfaces here as a 409.
 */
async function refundDeliveredOrder(orderId, items, reason, actor) {
  if (!items || !items.length) throw ApiError.badRequest('حداقل یک قلم برای استرداد لازم است');

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { payments: true } });
      if (!order) throw ApiError.notFound('سفارش یافت نشد');
      if (order.status !== 'DELIVERED') throw ApiError.conflict('فقط سفارش تحویل‌داده‌شده قابل استرداد است');

      const payment = order.payments.find((p) => p.status === 'SUCCESS');
      if (!payment) throw ApiError.conflict('پرداخت موفقی برای این سفارش یافت نشد یا قبلاً به‌طور کامل استرداد شده است');

      // Pass 1 — validate every requested line and compute its refund
      // amounts WITHOUT mutating anything yet, so a bad line (unknown
      // item, over-refund, ...) anywhere in the batch fails before any
      // wallet is touched.
      const refundLines = [];
      const storeDebits = new Map(); // storeId -> { sellerId, amount }
      let totalCustomerRefund = 0;
      let totalCommission = 0; // Ledger REFUND's PLATFORM_REVENUE debit — no-shortfall path only.

      // eslint-disable-next-line no-restricted-syntax
      for (const line of items) {
        if (!line.qty || line.qty <= 0) throw ApiError.badRequest('تعداد استرداد باید بزرگ‌تر از صفر باشد');

        // eslint-disable-next-line no-await-in-loop
        const orderItem = await tx.orderItem.findUnique({
          where: { id: line.orderItemId },
          include: {
            settlement: { include: { reversals: true } },
            store: { select: { sellerId: true } },
          },
        });
        if (!orderItem || orderItem.orderId !== orderId) throw ApiError.notFound('قلم سفارش یافت نشد');
        if (!orderItem.settlement) throw ApiError.conflict('این قلم سفارش هنوز تسویه نشده است');

        const alreadyRefundedQty = orderItem.settlement.reversals.reduce((s, r) => s + r.refundedQty, 0);
        const availableQty = orderItem.qty - alreadyRefundedQty;
        if (line.qty > availableQty) {
          throw ApiError.conflict(`تعداد درخواستی برای استرداد «${orderItem.nameSnapshot}» بیشتر از تعداد قابل استرداد باقی‌مانده است`);
        }

        const refundedGrossAmount = Number(orderItem.priceSnapshot) * line.qty;
        const refundedCommissionAmount = Math.round((refundedGrossAmount * Number(orderItem.settlement.commissionRate)) / 100);
        const refundedSellerEarning = refundedGrossAmount - refundedCommissionAmount;

        totalCustomerRefund += refundedGrossAmount;
        totalCommission += refundedCommissionAmount;

        const { storeId } = orderItem;
        const existingDebit = storeDebits.get(storeId) || { sellerId: orderItem.store.sellerId, amount: 0 };
        existingDebit.amount += refundedSellerEarning;
        storeDebits.set(storeId, existingDebit);

        refundLines.push({
          settlementId: orderItem.settlement.id,
          refundedQty: line.qty,
          refundedGrossAmount,
          refundedCommissionAmount,
          refundedSellerEarning,
        });
      }

      // Pass 1.5 — create the customer-side PaymentRefund NOW, before Pass 2,
      // so its id exists for SellerPayoutLiability.refundId below (P2.4:
      // SellerPayoutLiability now links back to the exact refund whose
      // clawback produced it — see that column's schema.prisma doc comment
      // — so the refund row must exist before any liability row does).
      // WALLET credits the customer immediately here, same as before this
      // reordering; GATEWAY only records a REQUESTED row, same as before —
      // reordering this earlier changes nothing about either function's own
      // behavior, only when refund.id becomes available to this function.
      // A delivered order's item refunds never include shipping (it's
      // non-refundable post-delivery — see this function's docstring), so
      // "fully refunded" for THIS payment means every item's gross amount
      // has been returned, i.e. order.subtotal — not order.total/payment.amount,
      // which also bakes in the non-refundable shipping fee. Passing this
      // override lets refundWallet flip Payment -> REFUNDED once all items
      // are refunded, without ever refunding shipping itself.
      const idempotencyKey = crypto.randomUUID();
      const refund = payment.method === 'WALLET'
        ? await refundWallet(payment.id, totalCustomerRefund, idempotencyKey, actor, 'POST_DELIVERY_REFUND', tx, Number(order.subtotal))
        : await refundGateway(payment.id, totalCustomerRefund, idempotencyKey, actor, 'POST_DELIVERY_REFUND', tx);

      // Pass 2 — the money movement. The customer refund must be able to
      // complete even if a seller's wallet can no longer fully cover their
      // clawback (e.g. they already withdrew it via a PayoutRequest — see
      // SellerPayoutLiability's model comment). So this collects as much
      // as the wallet currently holds (fast-path: the full amount, exactly
      // as before) and tracks any uncollected remainder as an additive
      // liability rather than throwing and rolling back the whole refund.
      // Tracks whether ANY affected store had a shortfall this call — the
      // Ledger REFUND journal (no fake balancing leg possible for the
      // shortfall path) is only posted when this stays false; see Pass 2
      // below and the postRefund call after Pass 2 completes.
      let anyShortfall = false;

      // eslint-disable-next-line no-restricted-syntax
      for (const [storeId, { sellerId, amount }] of storeDebits) {
        // Fast path — unchanged from before: full atomic conditional debit.
        // eslint-disable-next-line no-await-in-loop
        const debited = await tx.wallet.updateMany({
          where: { userId: sellerId, balance: { gte: amount } },
          data: { balance: { decrement: amount } },
        });

        let collected = amount;
        let shortfall = 0;

        if (debited.count !== 1) {
          // Wallet can't cover the full clawback — collect whatever it
          // currently has (never below zero) and track the rest as a
          // liability. Still a single atomic conditional updateMany (same
          // compare-and-swap pattern as everywhere else), just against the
          // wallet's own current balance instead of the full `amount`, so
          // it can never drive the balance negative even under a
          // concurrent debit racing this one (a genuine race here aborts
          // the whole Serializable transaction with P2034, caught below).
          // eslint-disable-next-line no-await-in-loop
          const wallet = await tx.wallet.findUnique({ where: { userId: sellerId } });
          if (!wallet) throw ApiError.internal('کیف پول فروشنده برای استرداد یافت نشد');

          collected = Math.min(Number(wallet.balance), amount);
          shortfall = amount - collected;

          if (collected > 0) {
            // eslint-disable-next-line no-await-in-loop
            const partial = await tx.wallet.updateMany({
              where: { userId: sellerId, balance: { gte: collected } },
              data: { balance: { decrement: collected } },
            });
            if (partial.count !== 1) {
              throw ApiError.conflict('استرداد دیگری هم‌زمان روی کیف پول این فروشنده در حال انجام است؛ لطفاً دوباره تلاش کنید');
            }
          }
        }

        if (collected > 0) {
          // eslint-disable-next-line no-await-in-loop
          const sellerWallet = await tx.wallet.findUnique({ where: { userId: sellerId } });
          // eslint-disable-next-line no-await-in-loop
          await tx.walletTransaction.create({
            data: {
              walletId: sellerWallet.id,
              type: 'DEBIT',
              amount: collected,
              reason: shortfall > 0
                ? `استرداد جزئی سفارش ${order.orderNumber} (مابقی به‌عنوان بدهی فروشنده ثبت شد)`
                : `استرداد سفارش ${order.orderNumber}`,
              refId: storeId,
            },
          });
        }

        if (shortfall > 0) {
          anyShortfall = true;
          // eslint-disable-next-line no-await-in-loop
          await tx.sellerPayoutLiability.create({
            data: {
              sellerId,
              orderId: order.id,
              storeId,
              // P2.4 — links this liability back to the exact refund whose
              // clawback attempt produced it (refund.id now exists — see
              // Pass 1.5 above — never associated later by orderId alone,
              // which would be ambiguous across multiple refunds/stores).
              refundId: refund.id,
              amount: shortfall,
              reason: `کسری کیف پول هنگام استرداد سفارش ${order.orderNumber} — قابل واریز مجدد از تسویه‌ها/برداشت‌های بعدی`,
            },
          });
        }
      }

      // P2.4 — persist the real ledgerStatus outcome of THIS call now that
      // Pass 2's seller-wallet clawback has actually run (never computed
      // later, never inferred from current Wallet.balance — see
      // PaymentRefundLedgerStatus's schema.prisma doc comment).
      //
      // WALLET: money movement is immediate, so the Ledger REFUND event is
      // still posted immediately too, exactly as before this change — only
      // when there was no shortfall. On a shortfall, no REFUND is posted
      // (fabricating a clean settlement reversal would misstate an
      // incomplete clawback) and there is no later confirmation step for a
      // WALLET refund (it is already PROCESSED) to post it from — the gap
      // is left for manual reconciliation, same as the GATEWAY shortfall
      // case below.
      //
      // GATEWAY: postRefund is NEVER called here regardless of anyShortfall
      // — deferred until markGatewayRefundProcessed's own claim succeeds
      // (Case A posts it for POSTABLE, Case B deliberately skips it for
      // SHORTFALL_HELD) — see that function's doc comment.
      let finalRefund;
      if (payment.method === 'WALLET' && !anyShortfall) {
        await postRefund(tx, {
          eventId: refund.id,
          actorId: null,
          customerId: order.userId,
          customerAmount: totalCustomerRefund,
          sellerRefunds: Array.from(storeDebits.values()).map(({ sellerId, amount }) => ({ sellerId, amount })),
          commissionAmount: totalCommission,
        });
        finalRefund = await tx.paymentRefund.update({ where: { id: refund.id }, data: { ledgerStatus: 'POSTED' } });
      } else {
        finalRefund = await tx.paymentRefund.update({
          where: { id: refund.id },
          data: { ledgerStatus: anyShortfall ? 'SHORTFALL_HELD' : 'POSTABLE' },
        });
      }

      // eslint-disable-next-line no-restricted-syntax
      for (const line of refundLines) {
        // eslint-disable-next-line no-await-in-loop
        await tx.orderItemSettlementReversal.create({
          data: {
            settlementId: line.settlementId,
            refundId: refund.id,
            refundedQty: line.refundedQty,
            refundedGrossAmount: line.refundedGrossAmount,
            refundedCommissionAmount: line.refundedCommissionAmount,
            refundedSellerEarning: line.refundedSellerEarning,
            reason: reason || null,
          },
        });
      }

      return { refund: finalRefund, totalCustomerRefund, itemsRefunded: refundLines.length };
    }, { isolationLevel: 'Serializable' });
  } catch (err) {
    // A Serializable transaction conflict (Prisma P2034) means this refund
    // lost a race with another concurrent refund touching the same
    // item(s) — surfaces as a clean 409 rather than a raw Prisma error, so
    // the loser can be safely retried by the caller once the other
    // request's result is visible.
    if (err.code === 'P2034') throw ApiError.conflict('استرداد دیگری هم‌زمان روی این سفارش در حال انجام است؛ لطفاً دوباره تلاش کنید');
    throw err;
  }

  await logAdminActivity(actor.id, `استرداد سفارش ${orderId} (${result.itemsRefunded} قلم)`);
  return result;
}

module.exports = {
  checkout,
  getById,
  listMine,
  listForStore,
  listSettlementsForStore,
  updateStatus,
  refundDeliveredOrder,
  ORDER_TRANSITIONS,
  SELLER_ALLOWED_STATUS_TARGETS,
  STATUS_LABELS,
};
