const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const service = require('./cart.service');

const getCart = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.getCart(req.user.id))));
const addItem = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.addItem(req.user.id, req.body), 'محصول به سبد خرید اضافه شد')));
const updateItem = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.updateItem(req.user.id, req.params.itemId, req.body.qty), 'سبد خرید به‌روزرسانی شد')));
const removeItem = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.removeItem(req.user.id, req.params.itemId), 'کالا از سبد خرید حذف شد')));
const clear = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.clear(req.user.id), 'سبد خرید خالی شد')));

module.exports = {
  getCart, addItem, updateItem, removeItem, clear,
};
