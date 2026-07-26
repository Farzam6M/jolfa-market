const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const service = require('./admin.service');
const usersService = require('../users/users.service');
const sellersService = require('../sellers/sellers.service');

const overview = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.getOverviewStats()));
});

const activityLog = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.getActivityLog()));
});

const createAdmin = asyncHandler(async (req, res) => {
  const admin = await usersService.createStaffUser(req.body, 'ADMIN', req.user);
  res.status(201).json(new ApiResponse(admin, 'حساب ادمین ایجاد شد'));
});

const deleteSeller = asyncHandler(async (req, res) => {
  const result = await sellersService.removeSeller(req.params.sellerId, req.user);
  res.json(new ApiResponse(result, 'فروشنده با موفقیت حذف شد'));
});

module.exports = {
  overview, activityLog, createAdmin, deleteSeller,
};
