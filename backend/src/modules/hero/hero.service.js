const { prisma } = require('../../config/database');
const ApiError = require('../../utils/ApiError');
const { deleteLocalUpload } = require('../../utils/uploadedFile');
const { logAdminActivity } = require('../admin/admin.service');
const { PERMISSIONS } = require('../roles/permissions.constants');

function canManage(requester) {
  return !!requester && (requester.permissions.includes('*') || requester.permissions.includes(PERMISSIONS.HERO_MANAGE));
}

/**
 * Public callers (customers, unauthenticated, sellers) only ever see slides
 * that are both isActive AND currently inside their optional [startAt, endAt]
 * schedule window — this is the entire "hero" contract the storefront reads
 * from. Staff holding HERO_MANAGE can pass includeInactive to instead get the
 * full, unfiltered set (any status, any schedule) for the admin screen.
 */
async function list({ includeInactive } = {}, requester) {
  const showAll = !!includeInactive && canManage(requester);
  const now = new Date();
  const where = showAll ? {} : {
    isActive: true,
    AND: [
      { OR: [{ startAt: null }, { startAt: { lte: now } }] },
      { OR: [{ endAt: null }, { endAt: { gte: now } }] },
    ],
  };
  return prisma.heroSlide.findMany({
    where,
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

/** Staff-only single-record fetch, used to populate an edit form. */
async function getById(id) {
  const slide = await prisma.heroSlide.findUnique({ where: { id } });
  if (!slide) throw ApiError.notFound('اسلاید یافت نشد');
  return slide;
}

async function create(data, actor) {
  if (!data.desktopImageUrl) throw ApiError.badRequest('تصویر دسکتاپ الزامی است');

  let displayOrder = data.displayOrder;
  if (displayOrder === undefined) {
    const last = await prisma.heroSlide.findFirst({ orderBy: { displayOrder: 'desc' } });
    displayOrder = last ? last.displayOrder + 1 : 0;
  }

  const slide = await prisma.heroSlide.create({
    data: {
      title: data.title,
      subtitle: data.subtitle,
      description: data.description,
      desktopImageUrl: data.desktopImageUrl,
      mobileImageUrl: data.mobileImageUrl,
      primaryButtonText: data.primaryButtonText,
      primaryButtonLink: data.primaryButtonLink,
      secondaryButtonText: data.secondaryButtonText,
      secondaryButtonLink: data.secondaryButtonLink,
      displayOrder,
      contentPosition: data.contentPosition,
      startAt: data.startAt,
      endAt: data.endAt,
    },
  });
  await logAdminActivity(actor.id, `ایجاد اسلاید هیرو «${slide.title}»`);
  return slide;
}

async function update(id, data, actor) {
  const existing = await prisma.heroSlide.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('اسلاید یافت نشد');

  const updated = await prisma.heroSlide.update({
    where: { id },
    data: {
      title: data.title,
      subtitle: data.subtitle,
      description: data.description,
      desktopImageUrl: data.desktopImageUrl,
      mobileImageUrl: data.mobileImageUrl,
      primaryButtonText: data.primaryButtonText,
      primaryButtonLink: data.primaryButtonLink,
      secondaryButtonText: data.secondaryButtonText,
      secondaryButtonLink: data.secondaryButtonLink,
      displayOrder: data.displayOrder,
      contentPosition: data.contentPosition,
      startAt: data.startAt,
      endAt: data.endAt,
    },
  });

  // Clean up any local upload files that were just replaced or explicitly
  // cleared — done AFTER the DB write succeeds, so a failed update never
  // deletes a file the (unchanged) record still references.
  if (data.desktopImageUrl !== existing.desktopImageUrl) deleteLocalUpload(existing.desktopImageUrl);
  if (data.mobileImageUrl !== existing.mobileImageUrl) deleteLocalUpload(existing.mobileImageUrl);

  await logAdminActivity(actor.id, `ویرایش اسلاید هیرو «${updated.title}»`);
  return updated;
}

async function setActive(id, isActive, actor) {
  const existing = await prisma.heroSlide.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('اسلاید یافت نشد');
  const updated = await prisma.heroSlide.update({ where: { id }, data: { isActive } });
  await logAdminActivity(actor.id, `${isActive ? 'فعال‌سازی' : 'غیرفعال‌سازی'} اسلاید هیرو «${existing.title}»`);
  return updated;
}

async function remove(id, actor) {
  const existing = await prisma.heroSlide.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound('اسلاید یافت نشد');
  await prisma.heroSlide.delete({ where: { id } });
  deleteLocalUpload(existing.desktopImageUrl);
  deleteLocalUpload(existing.mobileImageUrl);
  await logAdminActivity(actor.id, `حذف اسلاید هیرو «${existing.title}»`);
}

/**
 * Bulk re-order: `order` is the full, front-to-back list of slide ids. Every
 * id must belong to an existing slide (a stray/unknown id is rejected up
 * front instead of silently partial-applying), then displayOrder is set to
 * each id's position in the array inside a single transaction.
 */
async function reorder(order, actor) {
  const existingCount = await prisma.heroSlide.count({ where: { id: { in: order } } });
  if (existingCount !== order.length) {
    throw ApiError.badRequest('برخی شناسه‌های ارسالی معتبر نیستند یا تکراری هستند');
  }
  await prisma.$transaction(
    order.map((id, index) => prisma.heroSlide.update({ where: { id }, data: { displayOrder: index } })),
  );
  await logAdminActivity(actor.id, 'تغییر ترتیب نمایش اسلایدهای هیرو');
  return list({ includeInactive: true }, actor);
}

module.exports = {
  canManage, list, getById, create, update, setActive, remove, reorder,
};
