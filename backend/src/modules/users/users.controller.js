const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const ApiError = require('../../utils/ApiError');
const service = require('./users.service');

const getMe = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.getById(req.user.id)));
});

const updateMe = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.updateSelf(req.user.id, req.body), 'پروفایل به‌روزرسانی شد'));
});

const getOne = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.getById(req.params.id)));
});

const list = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.list(req.query)));
});

const updateAny = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.updateSelf(req.params.id, req.body), 'کاربر به‌روزرسانی شد'));
});

const updateStatus = asyncHandler(async (req, res) => {
  const updated = await service.updateStatus(req.params.id, req.body.status, req.user);
  res.json(new ApiResponse(updated, 'وضعیت کاربر به‌روزرسانی شد'));
});

const updateAvatar = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('فایل تصویر ارسال نشده است');
  const avatarUrl = `/uploads/${req.file.filename}`;
  res.json(new ApiResponse(await service.updateAvatar(req.user.id, avatarUrl), 'عکس پروفایل به‌روزرسانی شد'));
});

const updateContact = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.updateContact(req.user.id, req.body), 'اطلاعات تماس به‌روزرسانی شد'));
});

const listAddresses = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.listAddresses(req.user.id)));
});

const createAddress = asyncHandler(async (req, res) => {
  res.status(201).json(new ApiResponse(await service.createAddress(req.user.id, req.body), 'آدرس اضافه شد'));
});

const updateAddress = asyncHandler(async (req, res) => {
  res.json(new ApiResponse(await service.updateAddress(req.user.id, req.params.id, req.body), 'آدرس به‌روزرسانی شد'));
});

const deleteAddress = asyncHandler(async (req, res) => {
  await service.deleteAddress(req.user.id, req.params.id);
  res.json(new ApiResponse(null, 'آدرس حذف شد'));
});

const setDefaultAddress = asyncHandler(async (req, res) => {
  await service.setDefaultAddress(req.user.id, req.params.id);
  res.json(new ApiResponse(null, 'آدرس پیش‌فرض تنظیم شد'));
});

module.exports = {
  getMe,
  updateMe,
  getOne,
  list,
  updateAny,
  updateStatus,
  updateAvatar,
  updateContact,
  listAddresses,
  createAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
};
