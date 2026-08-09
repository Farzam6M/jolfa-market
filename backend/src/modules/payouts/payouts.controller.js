const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const service = require('./payouts.service');

// ──────────────────────────── Seller (self) ────────────────────────────

const create = asyncHandler(async (req, res) => res.status(201).json(
  new ApiResponse(await service.createPayout(req.user.id, req.body, req.user), 'درخواست برداشت وجه ثبت شد'),
));

const listMine = asyncHandler(async (req, res) => res.json(
  new ApiResponse(await service.listMine(req.user.id, req.query)),
));

// ──────────────────────────── Admin ────────────────────────────

const listAll = asyncHandler(async (req, res) => res.json(
  new ApiResponse(await service.listAll(req.query)),
));

const approve = asyncHandler(async (req, res) => res.json(
  new ApiResponse(await service.approvePayout(req.params.id, req.user), 'درخواست برداشت تأیید شد'),
));

const reject = asyncHandler(async (req, res) => res.json(
  new ApiResponse(await service.rejectPayout(req.params.id, req.body.reason, req.user), 'درخواست برداشت رد شد'),
));

const markProcessed = asyncHandler(async (req, res) => res.json(
  new ApiResponse(await service.markProcessed(req.params.id, req.user), 'واریز درخواست برداشت ثبت شد'),
));

const markFailed = asyncHandler(async (req, res) => res.json(
  new ApiResponse(await service.markFailed(req.params.id, req.body.failureReason, req.user), 'شکست واریز ثبت شد'),
));

module.exports = {
  create, listMine, listAll, approve, reject, markProcessed, markFailed,
};
