const { prisma } = require('../../config/database');

/**
 * Admin Commission / Earnings Report — Phase 3, read-only.
 *
 * Reads exclusively from OrderItemSettlement, which already holds the
 * point-in-time snapshot (commissionRate/grossAmount/commissionAmount/
 * sellerEarning) written at settlement time by
 * orders.service.js#settleDeliveredOrder. Deliberately does NOT re-resolve
 * commissionRuleId -> CommissionRule.rate to recompute anything — a rule
 * edited or deactivated after settlement must never change a historical
 * settlement's reported numbers (see the "Historical snapshot" tests in
 * order-settlement.test.js, which this endpoint must stay consistent with).
 *
 * Filters:
 *   dateFrom/dateTo -> OrderItemSettlement.settledAt
 *   storeId         -> OrderItemSettlement.storeId
 *   commissionRuleId -> OrderItemSettlement.commissionRuleId
 */
function buildWhere({
  dateFrom, dateTo, storeId, commissionRuleId,
} = {}) {
  const settledAt = {};
  if (dateFrom) settledAt.gte = dateFrom;
  if (dateTo) settledAt.lte = dateTo;

  return {
    ...(Object.keys(settledAt).length ? { settledAt } : {}),
    ...(storeId ? { storeId } : {}),
    ...(commissionRuleId ? { commissionRuleId } : {}),
  };
}

async function report(query = {}) {
  const { page = 1, pageSize = 20 } = query;
  const where = buildWhere(query);

  const [aggregate, items, total] = await Promise.all([
    prisma.orderItemSettlement.aggregate({
      where,
      _sum: { grossAmount: true, commissionAmount: true, sellerEarning: true },
      _count: true,
    }),
    prisma.orderItemSettlement.findMany({
      where,
      include: {
        store: { select: { id: true, name: true } },
        order: { select: { id: true, orderNumber: true } },
        commissionRule: { select: { id: true, scope: true } },
      },
      orderBy: { settledAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.orderItemSettlement.count({ where }),
  ]);

  return {
    summary: {
      totalGrossAmount: aggregate._sum.grossAmount ?? 0,
      totalCommissionAmount: aggregate._sum.commissionAmount ?? 0,
      totalSellerEarning: aggregate._sum.sellerEarning ?? 0,
      count: aggregate._count,
    },
    items,
    total,
    page,
    pageSize,
  };
}

module.exports = { report };
