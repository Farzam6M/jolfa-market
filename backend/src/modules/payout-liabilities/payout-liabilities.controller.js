const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const service = require('./payout-liabilities.service');

const listAll = asyncHandler(async (req, res) => res.json(
  new ApiResponse(await service.listLiabilities(req.query)),
));

module.exports = { listAll };
