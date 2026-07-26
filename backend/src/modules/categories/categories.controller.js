const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const service = require('./categories.service');

const list = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.list(req.query, req.user))));
const create = asyncHandler(async (req, res) => res.status(201).json(new ApiResponse(await service.create(req.body, req.user), 'دسته‌بندی ایجاد شد')));
const update = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.update(req.params.id, req.body, req.user), 'دسته‌بندی به‌روزرسانی شد')));
const setActive = asyncHandler(async (req, res) => res.json(new ApiResponse(
  await service.setActive(req.params.id, req.body.isActive, req.user),
  req.body.isActive ? 'دسته‌بندی فعال شد' : 'دسته‌بندی غیرفعال شد',
)));
const remove = asyncHandler(async (req, res) => { await service.remove(req.params.id, req.user); res.json(new ApiResponse(null, 'دسته‌بندی حذف شد')); });

module.exports = {
  list, create, update, setActive, remove,
};
