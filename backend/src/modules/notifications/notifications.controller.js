const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const service = require('./notifications.service');

const list = asyncHandler(async (req, res) => {
  const notifications = await service.getVisibleForUser(req.user);
  res.json(new ApiResponse(notifications));
});

const dismiss = asyncHandler(async (req, res) => {
  await service.dismiss(req.user, req.params.id);
  res.json(new ApiResponse(null, 'اعلان حذف شد'));
});

const markRead = asyncHandler(async (req, res) => {
  await service.markRead(req.user, req.params.id);
  res.json(new ApiResponse(null, 'اعلان خوانده‌شده علامت‌گذاری شد'));
});

const markAllRead = asyncHandler(async (req, res) => {
  const count = await service.markAllRead(req.user.id, req.user);
  res.json(new ApiResponse({ count }, 'همه اعلان‌ها خوانده‌شده علامت‌گذاری شدند'));
});

const broadcast = asyncHandler(async (req, res) => {
  const notification = await service.pushNotification(req.body);
  res.status(201).json(new ApiResponse(notification, 'اعلان ارسال شد'));
});

module.exports = {
  list, dismiss, markRead, markAllRead, broadcast,
};
