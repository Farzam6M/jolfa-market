const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const service = require('./stores.service');

const list = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.list(req.query, req.user))));
const getBySlug = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.getBySlug(req.params.slug, req.user))));
const getOwn = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.getOwnByUserId(req.user.id))));
const updateOwn = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.updateOwn(req.user.id, req.body), 'فروشگاه به‌روزرسانی شد')));
const adminUpdate = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.adminUpdate(req.params.id, req.body), 'فروشگاه به‌روزرسانی شد')));
const createDirect = asyncHandler(async (req, res) => res.status(201).json(new ApiResponse(await service.createDirect(req.body, req.user), 'فروشگاه ثبت و فعال شد')));
const moderate = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.moderate(req.params.id, req.body.status, req.user), 'وضعیت فروشگاه به‌روزرسانی شد')));

module.exports = {
  list, getBySlug, getOwn, updateOwn, adminUpdate, createDirect, moderate,
};
