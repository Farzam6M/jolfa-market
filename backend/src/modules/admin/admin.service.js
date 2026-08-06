const { prisma } = require('../../config/database');

/** Append-only audit trail — mirrors the frontend's jm_admin_activity_log, used by the admin overview "آخرین فعالیت‌ها" feed. */
async function logAdminActivity(actorId, action, meta = null) {
  return prisma.adminActivityLog.create({ data: { actorId, action, meta } });
}

async function getActivityLog({ take = 50 } = {}) {
  return prisma.adminActivityLog.findMany({
    orderBy: { createdAt: 'desc' },
    take,
    include: { actor: { select: { id: true, name: true } } },
  });
}

/** Real-time dashboard stats computed straight from the DB (not hardcoded), mirroring renderAdminOverviewStats() in the frontend. */
async function getOverviewStats() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Same "seller not soft-deleted" condition stores.service.js::list() applies
  // to its APPROVED branch — kept identical here so activeStores can never
  // disagree with what GET /stores?status=APPROVED (the "مدیریت فروشندگان"
  // table's APPROVED rows) actually returns.
  const activeStoreWhere = { status: 'APPROVED', seller: { deletedAt: null } };
  // Same conditions products.service.js::list() applies to its public/
  // non-own branch (isActive + store not SUSPENDED + seller not soft-deleted)
  // — kept identical here so activeProducts can never disagree with what the
  // public/customer product catalogue actually shows.
  const activeProductWhere = {
    status: 'APPROVED',
    isActive: true,
    store: { status: { not: 'SUSPENDED' }, seller: { deletedAt: null } },
  };

  const [storeCount, userCount, newUsersWeek, productCount, approvedThisWeek, pendingProducts, pendingStores, pendingSellerApps] = await Promise.all([
    prisma.store.count({ where: activeStoreWhere }),
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.storeProduct.count({ where: activeProductWhere }),
    prisma.storeProduct.count({ where: { ...activeProductWhere, updatedAt: { gte: weekAgo } } }),
    prisma.storeProduct.count({ where: { status: 'PENDING' } }),
    prisma.store.count({ where: { status: 'PENDING' } }),
    prisma.sellerApplication.count({ where: { status: 'PENDING' } }),
  ]);

  return {
    activeStores: storeCount,
    registeredUsers: userCount,
    newUsersThisWeek: newUsersWeek,
    activeProducts: productCount,
    newProductsThisWeek: approvedThisWeek,
    pendingApproval: pendingProducts + pendingStores + pendingSellerApps,
    pendingProducts,
    pendingStores,
    pendingSellerApplications: pendingSellerApps,
  };
}

module.exports = { logAdminActivity, getActivityLog, getOverviewStats };
