const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const service = require('./orders.service');

const checkout = asyncHandler(async (req, res) => res.status(201).json(new ApiResponse(await service.checkout(req.user.id, req.body), 'سفارش با موفقیت ثبت شد')));
const getById = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.getById(req.params.id, req.user))));
const listMine = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.listMine(req.user.id, req.query))));
const listForStore = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.listForStore(req.user.id, req.query))));
const listSettlementsForStore = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.listSettlementsForStore(req.user.id, req.query))));
const updateStatus = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.updateStatus(req.params.id, req.body.status, req.user), 'وضعیت سفارش به‌روزرسانی شد')));
const refundOrder = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.refundDeliveredOrder(req.params.id, req.body.items, req.body.reason, req.user), 'استرداد سفارش ثبت شد')));

module.exports = {
  checkout, getById, listMine, listForStore, listSettlementsForStore, updateStatus, refundOrder,
};
