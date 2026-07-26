const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const ApiError = require('../../utils/ApiError');
const service = require('./products.service');

const list = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.list(req.query, req.user))));
const getById = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.getById(req.params.id, req.user))));
const create = asyncHandler(async (req, res) => res.status(201).json(new ApiResponse(await service.create(req.user.id, req.body, req.user), 'محصول برای بررسی ارسال شد')));
const update = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.update(req.params.id, req.user, req.body), 'محصول ویرایش شد و منتظر تایید مجدد است')));
const remove = asyncHandler(async (req, res) => { await service.remove(req.params.id, req.user); res.json(new ApiResponse(null, 'محصول حذف شد')); });
const moderate = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.moderate(req.params.id, req.body, req.user), 'محصول بررسی شد')));
// Adapter for the admin front-end's PATCH /:id/status { status, reason } shape
// — same service call as /moderate, just remapping reason -> note.
const moderateByStatusAlias = asyncHandler(async (req, res) => res.json(new ApiResponse(
  await service.moderate(req.params.id, { status: req.body.status, note: req.body.reason }, req.user),
  'محصول بررسی شد',
)));
const updateStock = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.updateStock(req.params.id, req.user, req.body), 'موجودی به‌روزرسانی شد')));
const toggleActive = asyncHandler(async (req, res) => res.json(new ApiResponse(
  await service.toggleActive(req.params.id, req.user, req.body.isActive),
  req.body.isActive ? 'محصول فعال شد' : 'محصول غیرفعال شد',
)));

// Accepts EITHER a multipart file upload (req.file, via the upload middleware)
// OR a JSON { url } body — whichever the caller used. At least one is required.
const addImage = asyncHandler(async (req, res) => {
  const url = req.file ? `/uploads/${req.file.filename}` : req.body.url;
  if (!url) throw ApiError.badRequest('تصویری ارسال نشده است');
  const image = await service.addImage(req.params.id, req.user, url);
  res.status(201).json(new ApiResponse(image, 'تصویر اضافه شد'));
});
const removeImage = asyncHandler(async (req, res) => {
  await service.removeImage(req.params.id, req.params.imageId, req.user);
  res.json(new ApiResponse(null, 'تصویر حذف شد'));
});

module.exports = {
  list, getById, create, update, remove, moderate, moderateByStatusAlias, updateStock, toggleActive, addImage, removeImage,
};
