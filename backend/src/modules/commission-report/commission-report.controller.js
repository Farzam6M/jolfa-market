const asyncHandler = require('../../utils/asyncHandler');
const ApiResponse = require('../../utils/ApiResponse');
const service = require('./commission-report.service');

const report = asyncHandler(async (req, res) => res.json(new ApiResponse(await service.report(req.query))));

module.exports = { report };
