const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const service = require('./wishlist.service');

const list = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.list(req.user.id))));
const add = asyncHandler(async (req, res) => res.status(201).json(new ApiResponse(await service.add(req.user.id, req.body.productId), 'به علاقه‌مندی‌ها اضافه شد')));
const remove = asyncHandler(async (req, res) => { await service.remove(req.user.id, req.params.productId); res.json(new ApiResponse(null, 'از علاقه‌مندی‌ها حذف شد')); });

module.exports = { list, add, remove };
