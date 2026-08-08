const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { logAdminActivity } = require('../admin/admin.service');

/**
 * ════════════════════════════════════════════════════════════════════
 * SCOPE / PRIORITY ORDERING — the single source of truth for how a
 * commission rate is picked for a given (sellerId, categoryId, now).
 *
 *   CAMPAIGN > SELLER > CATEGORY > GLOBAL
 *
 * 1. CAMPAIGN — every active CAMPAIGN rule whose [campaignStartAt,
 *    campaignEndAt] window contains `now`, AND whose own sellerId/categoryId
 *    (if set) matches the given sellerId/categoryId, is a candidate. A
 *    CAMPAIGN rule with sellerId/categoryId left null applies to everyone
 *    (an unscoped campaign). Candidates are ranked by SPECIFICITY first —
 *    (seller+category) > (seller only) > (category only) > (neither) — then
 *    by `priority` (higher wins), then by `createdAt` (most recent wins),
 *    then by `id` (lexicographically, purely for absolute determinism if
 *    every other field ties). The top-ranked candidate wins this tier.
 * 2. SELLER — if no CAMPAIGN rule applied, the active SELLER rule for this
 *    exact sellerId (if any). Same priority/createdAt/id tie-break if,
 *    unusually, more than one exists.
 * 3. CATEGORY — if no SELLER rule applied, the active CATEGORY rule for
 *    this exact categoryId (if any). Same tie-break.
 * 4. GLOBAL — the active GLOBAL rule. Same tie-break. GLOBAL is guaranteed
 *    to always have at least one active row (see
 *    assertNotRemovingLastActiveGlobal below), so this tier never falls
 *    through to "no rule found" in a correctly-operating system — if it
 *    somehow does, that is a data-integrity bug, not a normal business
 *    case, so we throw rather than silently defaulting to 0%.
 * ════════════════════════════════════════════════════════════════════
 */

/** Highest priority first, then most recently created, then id — for full determinism among same-specificity ties. */
function byPriorityThenRecency(a, b) {
  if (b.priority !== a.priority) return b.priority - a.priority;
  const byCreatedAt = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  if (byCreatedAt !== 0) return byCreatedAt;
  return a.id < b.id ? -1 : 1;
}

function campaignSpecificity(rule, sellerId, categoryId) {
  const sellerMatch = !!rule.sellerId && rule.sellerId === sellerId;
  const categoryMatch = !!rule.categoryId && rule.categoryId === categoryId;
  if (sellerMatch && categoryMatch) return 3;
  if (sellerMatch) return 2;
  if (categoryMatch) return 1;
  return 0; // fully unscoped campaign
}

function pickBestCampaign(candidates, sellerId, categoryId) {
  return candidates
    .slice()
    .sort((a, b) => {
      const specDiff = campaignSpecificity(b, sellerId, categoryId) - campaignSpecificity(a, sellerId, categoryId);
      if (specDiff !== 0) return specDiff;
      return byPriorityThenRecency(a, b);
    })[0];
}

function pickBest(candidates) {
  if (candidates.length === 0) return null;
  return candidates.slice().sort(byPriorityThenRecency)[0];
}

/**
 * Resolves the single applicable CommissionRule for an order line, per the
 * priority ordering documented above. Returns the winning rule's `rate`
 * (a Prisma Decimal) together with the rule itself, so callers that need to
 * record *which* rule was applied (e.g. for a seller ledger entry) can do so
 * without a second query.
 *
 * @param {string|null|undefined} sellerId   Store.id — the seller/store this order line belongs to.
 * @param {string|null|undefined} categoryId Category.id — the product's category.
 * @param {Date} now
 */
async function resolveCommissionRate(sellerId, categoryId, now = new Date()) {
  // 1. CAMPAIGN — active, in-window, and (unscoped OR matching this seller/category).
  // Built conditionally rather than passing `sellerId: sellerId || undefined`
  // directly into the OR array — Prisma silently drops `undefined`-valued
  // keys, which would turn that OR branch into `{}` (an always-true match),
  // defeating the "must match this exact seller/category, or be unscoped"
  // filter entirely when no sellerId/categoryId is given.
  const sellerOr = sellerId ? [{ sellerId: null }, { sellerId }] : [{ sellerId: null }];
  const categoryOr = categoryId ? [{ categoryId: null }, { categoryId }] : [{ categoryId: null }];
  const campaignCandidates = await prisma.commissionRule.findMany({
    where: {
      scope: 'CAMPAIGN',
      isActive: true,
      campaignStartAt: { lte: now },
      campaignEndAt: { gte: now },
      AND: [{ OR: sellerOr }, { OR: categoryOr }],
    },
  });
  const campaignWinner = campaignCandidates.length ? pickBestCampaign(campaignCandidates, sellerId, categoryId) : null;
  if (campaignWinner) return { rule: campaignWinner, rate: campaignWinner.rate };

  // 2. SELLER
  if (sellerId) {
    const sellerCandidates = await prisma.commissionRule.findMany({
      where: { scope: 'SELLER', isActive: true, sellerId },
    });
    const sellerWinner = pickBest(sellerCandidates);
    if (sellerWinner) return { rule: sellerWinner, rate: sellerWinner.rate };
  }

  // 3. CATEGORY
  if (categoryId) {
    const categoryCandidates = await prisma.commissionRule.findMany({
      where: { scope: 'CATEGORY', isActive: true, categoryId },
    });
    const categoryWinner = pickBest(categoryCandidates);
    if (categoryWinner) return { rule: categoryWinner, rate: categoryWinner.rate };
  }

  // 4. GLOBAL — must always resolve; a missing active GLOBAL rule is a data-integrity bug.
  const globalCandidates = await prisma.commissionRule.findMany({
    where: { scope: 'GLOBAL', isActive: true },
  });
  const globalWinner = pickBest(globalCandidates);
  if (!globalWinner) throw ApiError.internal('هیچ قانون کمیسیون سراسری فعالی یافت نشد');
  return { rule: globalWinner, rate: globalWinner.rate };
}

/**
 * Validates scope/reference combination rules against the FULLY MERGED
 * record (existing row + incoming patch, for update; the payload itself,
 * for create). This is the authoritative check — the Zod schema only
 * catches same-request inconsistencies, not a PATCH that only touches one
 * field of an otherwise-invalid combination.
 */
function assertValidCombo(merged) {
  const {
    scope, sellerId, categoryId, campaignStartAt, campaignEndAt,
  } = merged;

  if (scope === 'GLOBAL' && (sellerId || categoryId)) {
    throw ApiError.badRequest('قانون سراسری (GLOBAL) نمی‌تواند فروشگاه یا دسته‌بندی داشته باشد');
  }
  if (scope === 'SELLER' && !sellerId) {
    throw ApiError.badRequest('شناسه فروشگاه برای قانون SELLER الزامی است');
  }
  if (scope === 'SELLER' && categoryId) {
    throw ApiError.badRequest('قانون مخصوص فروشگاه (SELLER) نمی‌تواند دسته‌بندی داشته باشد');
  }
  if (scope === 'CATEGORY' && !categoryId) {
    throw ApiError.badRequest('شناسه دسته‌بندی برای قانون CATEGORY الزامی است');
  }
  if (scope === 'CATEGORY' && sellerId) {
    throw ApiError.badRequest('قانون مخصوص دسته‌بندی (CATEGORY) نمی‌تواند فروشگاه داشته باشد');
  }
  if (scope !== 'CAMPAIGN' && (campaignStartAt || campaignEndAt)) {
    throw ApiError.badRequest('بازه زمانی کمپین فقط برای قانون‌های CAMPAIGN مجاز است');
  }
  if (scope === 'CAMPAIGN' && (!campaignStartAt || !campaignEndAt)) {
    throw ApiError.badRequest('زمان شروع و پایان کمپین برای قانون CAMPAIGN الزامی است');
  }
  if (campaignStartAt && campaignEndAt && new Date(campaignEndAt) <= new Date(campaignStartAt)) {
    throw ApiError.badRequest('پایان کمپین باید بعد از شروع آن باشد');
  }
}

async function assertReferencesExist({ sellerId, categoryId }) {
  if (sellerId) {
    const store = await prisma.store.findUnique({ where: { id: sellerId } });
    if (!store) throw ApiError.badRequest('فروشگاه یافت نشد');
  }
  if (categoryId) {
    const category = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!category) throw ApiError.badRequest('دسته‌بندی یافت نشد');
  }
}

/**
 * Blocks any operation that would leave zero active GLOBAL rules —
 * deactivating (isActive: false), rescoping away from GLOBAL, or deleting
 * the last one. `excludeId` is the rule being mutated (so it doesn't count
 * against itself when checking "is there at least one OTHER active GLOBAL
 * rule").
 */
async function assertNotRemovingLastActiveGlobal(excludeId) {
  const otherActiveGlobalCount = await prisma.commissionRule.count({
    where: { scope: 'GLOBAL', isActive: true, id: { not: excludeId } },
  });
  if (otherActiveGlobalCount === 0) {
    throw ApiError.conflict('حداقل یک قانون کمیسیون سراسری (GLOBAL) فعال باید همیشه وجود داشته باشد');
  }
}

async function list({ scope, sellerId, categoryId } = {}) {
  return prisma.commissionRule.findMany({
    where: {
      ...(scope ? { scope } : {}),
      ...(sellerId ? { sellerId } : {}),
      ...(categoryId ? { categoryId } : {}),
    },
    orderBy: [{ scope: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }],
  });
}

async function create(data, actor) {
  assertValidCombo(data);
  await assertReferencesExist(data);

  const rule = await prisma.commissionRule.create({
    data: {
      scope: data.scope,
      sellerId: data.sellerId ?? null,
      categoryId: data.categoryId ?? null,
      campaignStartAt: data.campaignStartAt ?? null,
      campaignEndAt: data.campaignEndAt ?? null,
      rate: data.rate,
      priority: data.priority ?? 0,
      isActive: data.isActive ?? true,
      createdById: actor.id, // never taken from the request body
    },
  });
  await logAdminActivity(actor.id, `ایجاد قانون کمیسیون (${rule.scope}) با نرخ ${rule.rate}%`);
  return rule;
}

async function update(id, data, actor) {
  const existing = await prisma.commissionRule.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('قانون کمیسیون یافت نشد');

  // Merge onto the existing row so combo validation always sees the full
  // resulting record, not just whatever subset of fields this PATCH sent.
  const merged = {
    scope: data.scope !== undefined ? data.scope : existing.scope,
    sellerId: data.sellerId !== undefined ? data.sellerId : existing.sellerId,
    categoryId: data.categoryId !== undefined ? data.categoryId : existing.categoryId,
    campaignStartAt: data.campaignStartAt !== undefined ? data.campaignStartAt : existing.campaignStartAt,
    campaignEndAt: data.campaignEndAt !== undefined ? data.campaignEndAt : existing.campaignEndAt,
  };
  assertValidCombo(merged);
  await assertReferencesExist(merged);

  const willBeActive = data.isActive !== undefined ? data.isActive : existing.isActive;
  const willBeGlobal = merged.scope === 'GLOBAL';
  const wasActiveGlobal = existing.scope === 'GLOBAL' && existing.isActive;
  // Only need to guard when this update would take an active GLOBAL rule
  // out of the active-GLOBAL pool (by deactivating it or by rescoping it away).
  if (wasActiveGlobal && (!willBeActive || !willBeGlobal)) {
    await assertNotRemovingLastActiveGlobal(id);
  }

  const updated = await prisma.commissionRule.update({
    where: { id },
    data: {
      ...(data.scope !== undefined ? { scope: data.scope } : {}),
      ...(data.sellerId !== undefined ? { sellerId: data.sellerId } : {}),
      ...(data.categoryId !== undefined ? { categoryId: data.categoryId } : {}),
      ...(data.campaignStartAt !== undefined ? { campaignStartAt: data.campaignStartAt } : {}),
      ...(data.campaignEndAt !== undefined ? { campaignEndAt: data.campaignEndAt } : {}),
      ...(data.rate !== undefined ? { rate: data.rate } : {}),
      ...(data.priority !== undefined ? { priority: data.priority } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    },
  });
  await logAdminActivity(actor.id, `ویرایش قانون کمیسیون (${updated.scope}) با نرخ ${updated.rate}%`);
  return updated;
}

async function remove(id, actor) {
  const existing = await prisma.commissionRule.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('قانون کمیسیون یافت نشد');

  if (existing.scope === 'GLOBAL' && existing.isActive) {
    await assertNotRemovingLastActiveGlobal(id);
  }

  await prisma.commissionRule.delete({ where: { id } });
  await logAdminActivity(actor.id, `حذف قانون کمیسیون (${existing.scope}) با نرخ ${existing.rate}%`);
}

module.exports = {
  list, create, update, remove, resolveCommissionRate, assertValidCombo, assertNotRemovingLastActiveGlobal,
};