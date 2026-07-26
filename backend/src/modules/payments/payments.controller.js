const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const service = require('./payments.service');

const pay = asyncHandler(async (req, res) => res.status(201).json(new ApiResponse(await service.pay(req.user.id, req.body), 'درخواست پرداخت ثبت شد')));
const getWallet = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.getWallet(req.user.id))));
const list = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.listAll(req.query))));
// Called by the payment gateway itself (server-to-server), not by a logged-in
// user — see the TODO in payments.routes.js about signature verification.
const gatewayCallback = asyncHandler(async (req, res) => {
  await service.confirmGateway(req.body.transactionRef, req.body.success);
  res.json(new ApiResponse(null, 'دریافت شد'));
});

module.exports = {
  pay, getWallet, gatewayCallback, list,
};
