const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const ApiError = require('../../utils/ApiError');
const { deleteLocalUpload } = require('../../utils/uploadedFile');
const service = require('./hero.service');

/**
 * Resolves an image field from either a multipart upload (req.files, via
 * upload.middleware's `.fields([...])`) or a plain JSON/body URL string —
 * whichever the caller used. An explicit empty-string body value means
 * "clear this image" (only meaningful for the optional mobileImageUrl) and
 * resolves to null. Falls back to `fallback` (the previous value) when the
 * field wasn't sent at all, so a PATCH that doesn't touch the image can't
 * accidentally clear it.
 */
function resolveImageUrl(req, fieldName, urlField, fallback) {
  const file = req.files?.[fieldName]?.[0];
  if (file) return `/uploads/${file.filename}`;
  if (req.body[urlField] === '') return null;
  if (req.body[urlField] !== undefined) return req.body[urlField];
  return fallback;
}

/** Deletes any file(s) this request just uploaded — used to roll back orphans when the DB write that would reference them fails. */
function cleanupUploadedFiles(req, desktopImageUrl, mobileImageUrl) {
  if (req.files?.desktopImage?.[0]) deleteLocalUpload(desktopImageUrl);
  if (req.files?.mobileImage?.[0]) deleteLocalUpload(mobileImageUrl);
}

const list = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.list(req.query, req.user))));
const getById = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.getById(req.params.id))));

const create = asyncHandler(async (req, res) => {
  const desktopImageUrl = resolveImageUrl(req, 'desktopImage', 'desktopImageUrl');
  const mobileImageUrl = resolveImageUrl(req, 'mobileImage', 'mobileImageUrl');
  if (!desktopImageUrl) throw ApiError.badRequest('تصویر دسکتاپ الزامی است (آپلود فایل یا آدرس تصویر)');
  try {
    const slide = await service.create({ ...req.body, desktopImageUrl, mobileImageUrl }, req.user);
    res.status(201).json(new ApiResponse(slide, 'اسلاید هیرو ایجاد شد'));
  } catch (err) {
    // The DB write failed — never leave a freshly-uploaded file orphaned on disk.
    cleanupUploadedFiles(req, desktopImageUrl, mobileImageUrl);
    throw err;
  }
});

const update = asyncHandler(async (req, res) => {
  const existing = await service.getById(req.params.id);
  const desktopImageUrl = resolveImageUrl(req, 'desktopImage', 'desktopImageUrl', existing.desktopImageUrl);
  const mobileImageUrl = resolveImageUrl(req, 'mobileImage', 'mobileImageUrl', existing.mobileImageUrl);
  if (!desktopImageUrl) throw ApiError.badRequest('تصویر دسکتاپ نمی‌تواند حذف شود؛ فقط می‌توان آن را جایگزین کرد');
  try {
    const slide = await service.update(req.params.id, { ...req.body, desktopImageUrl, mobileImageUrl }, req.user);
    res.json(new ApiResponse(slide, 'اسلاید هیرو ویرایش شد'));
  } catch (err) {
    cleanupUploadedFiles(req, desktopImageUrl, mobileImageUrl);
    throw err;
  }
});

const setActive = asyncHandler(async (req, res) => res.json(new ApiResponse(
  await service.setActive(req.params.id, req.body.isActive, req.user),
  req.body.isActive ? 'اسلاید فعال شد' : 'اسلاید غیرفعال شد',
)));

const remove = asyncHandler(async (req, res) => { await service.remove(req.params.id, req.user); res.json(new ApiResponse(null, 'اسلاید حذف شد')); });

const reorder = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.reorder(req.body.order, req.user), 'ترتیب نمایش به‌روزرسانی شد')));

module.exports = {
  list, getById, create, update, setActive, remove, reorder,
};
