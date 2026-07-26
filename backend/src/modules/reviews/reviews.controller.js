const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const service = require('./reviews.service');

const listForProduct = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.listForProduct(req.params.productId))));
const create = asyncHandler(async (req, res) => res.status(201).json(new ApiResponse(await service.create(req.user.id, req.body), 'نظر شما ثبت شد و پس از تایید نمایش داده می‌شود')));
const remove = asyncHandler(async (req, res) => { await service.remove(req.params.id, req.user.id); res.json(new ApiResponse(null, 'نظر حذف شد')); });
const moderate = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.moderate(req.params.id, req.body.status, req.user), 'نظر بررسی شد')));

module.exports = {
  listForProduct, create, remove, moderate,
};
