const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { logAdminActivity } = require('../admin/admin.service');
const { PERMISSIONS } = require('../roles/permissions.constants');

function canManage(requester) {
  return !!requester && (requester.permissions.includes('*') || requester.permissions.includes(PERMISSIONS.CATEGORIES_MANAGE));
}

/**
 * Public callers (customers, unauthenticated, sellers) only ever see the
 * active-category tree — an inactive category (and the `isActive` filter
 * itself) is a staff-only concept. `includeInactive` is silently ignored
 * for anyone without CATEGORIES_MANAGE.
 */
async function list({ includeInactive } = {}, requester) {
  const showInactive = !!includeInactive && canManage(requester);
  return prisma.category.findMany({
    where: { parentId: null, ...(showInactive ? {} : { isActive: true }) },
    include: {
      children: { where: showInactive ? {} : { isActive: true } },
    },
    orderBy: { name: 'asc' },
  });
}

async function create(data, actor) {
  if (data.parentId) {
    const parent = await prisma.category.findUnique({ where: { id: data.parentId } });
    if (!parent) throw ApiError.badRequest('دسته‌بندی والد یافت نشد');
  }
  let category;
  try {
    category = await prisma.category.create({ data });
  } catch (err) {
    if (err.code === 'P2002') throw ApiError.conflict('اسلاگ دسته‌بندی تکراری است');
    throw err;
  }
  await logAdminActivity(actor.id, `ایجاد دسته‌بندی «${category.name}»`);
  return category;
}

async function update(id, data, actor) {
  const category = await prisma.category.findUnique({ where: { id } });
  if (!category) throw ApiError.notFound('دسته‌بندی یافت نشد');
  if (data.parentId) {
    if (data.parentId === id) throw ApiError.badRequest('دسته‌بندی نمی‌تواند والد خودش باشد');
    const parent = await prisma.category.findUnique({ where: { id: data.parentId } });
    if (!parent) throw ApiError.badRequest('دسته‌بندی والد یافت نشد');
  }
  let updated;
  try {
    updated = await prisma.category.update({ where: { id }, data });
  } catch (err) {
    if (err.code === 'P2002') throw ApiError.conflict('اسلاگ دسته‌بندی تکراری است');
    throw err;
  }
  await logAdminActivity(actor.id, `ویرایش دسته‌بندی «${updated.name}»`);
  return updated;
}

/**
 * Enable/disable a category. Disabling doesn't touch existing products
 * (their categoryId is left as-is), it only removes the category from the
 * public tree and blocks it from being selected on new/edited products —
 * that selection rule is enforced in products.service (assertCategoryUsable).
 */
async function setActive(id, isActive, actor) {
  const category = await prisma.category.findUnique({ where: { id } });
  if (!category) throw ApiError.notFound('دسته‌بندی یافت نشد');
  const updated = await prisma.category.update({ where: { id }, data: { isActive } });
  await logAdminActivity(actor.id, `${isActive ? 'فعال‌سازی' : 'غیرفعال‌سازی'} دسته‌بندی «${category.name}»`);
  return updated;
}

/**
 * Deletion is blocked while the category (or any of its direct children)
 * still has an active product attached — deleting out from under a live
 * listing would either orphan it or cascade-delete it depending on the FK,
 * neither of which is safe to do silently. The caller must reassign or
 * deactivate those products first.
 */
async function remove(id, actor) {
  const category = await prisma.category.findUnique({ where: { id }, include: { children: true } });
  if (!category) throw ApiError.notFound('دسته‌بندی یافت نشد');

  const categoryIds = [id, ...category.children.map((c) => c.id)];
  const activeProductCount = await prisma.storeProduct.count({
    where: { product: { categoryId: { in: categoryIds } }, isActive: true, status: { not: 'ARCHIVED' } },
  });
  if (activeProductCount > 0) {
    throw ApiError.conflict(`این دسته‌بندی ${activeProductCount} محصول فعال دارد؛ ابتدا محصولات را جابه‌جا یا غیرفعال کنید`);
  }
  if (category.children.length > 0) {
    throw ApiError.conflict('این دسته‌بندی دارای زیردسته است؛ ابتدا زیردسته‌ها را حذف یا جابه‌جا کنید');
  }

  await prisma.category.delete({ where: { id } });
  await logAdminActivity(actor.id, `حذف دسته‌بندی «${category.name}»`);
}

/** Used by products.service to enforce "category must exist and be active" on create/update. */
async function assertCategoryUsable(categoryId) {
  if (!categoryId) return;
  const category = await prisma.category.findUnique({ where: { id: categoryId } });
  if (!category) throw ApiError.badRequest('دسته‌بندی نامعتبر است');
  if (!category.isActive) throw ApiError.badRequest('این دسته‌بندی غیرفعال است و قابل انتخاب نیست');
}

module.exports = {
  list, create, update, setActive, remove, assertCategoryUsable,
};
