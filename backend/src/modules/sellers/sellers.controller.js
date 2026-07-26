const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const service = require('./sellers.service');

const apply = asyncHandler(async (req, res) => {
  res.status(201).json(new ApiResponse(await service.apply(req.user.id, req.body), 'درخواست فروشندگی ثبت شد'));
});

const me = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.getMyApplication(req.user.id)));
});

const listApplications = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.listApplications(req.query)));
});

const review = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.review(req.params.id, req.body, req.user), 'درخواست بررسی شد'));
});

module.exports = { apply, me, listApplications, review };
