const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const service = require('./commission-rules.service');

const list = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.list(req.query))));
const create = asyncHandler(async (req, res) => res.status(201).json(new ApiResponse(await service.create(req.body, req.user), 'قانون کمیسیون ایجاد شد')));
const update = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.update(req.params.id, req.body, req.user), 'قانون کمیسیون به‌روزرسانی شد')));
const remove = asyncHandler(async (req, res) => { await service.remove(req.params.id, req.user); res.json(new ApiResponse(null, 'قانون کمیسیون حذف شد')); });

module.exports = {
  list, create, update, remove,
};