const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const env = require('../config/env');

function notFoundHandler(req, res, next) {
  next(ApiError.notFound(`مسیر ${req.originalUrl} یافت نشد`));
}

// Prisma-specific error translation kept isolated here so services never
// need to know about ORM internals.
function translatePrismaError(err) {
  if (err.code === 'P2002') {
    const fields = (err.meta?.target || []).join(', ');
    return ApiError.conflict(`مقدار تکراری برای فیلد(های): ${fields}`);
  }
  if (err.code === 'P2025') {
    return ApiError.notFound('رکورد مرتبط یافت نشد');
  }
  if (err.code === 'P2003') {
    return ApiError.badRequest('ارجاع به رکورد نامعتبر است (کلید خارجی)');
  }
  return null;
}

// Multer (upload middleware) errors — e.g. a file over MAX_UPLOAD_MB, or an
// unexpected field name — surface as err.name === 'MulterError' and would
// otherwise fall through to a generic 500. Translated here so every upload
// endpoint (products, users, hero, ...) gets a clear, actionable 400.
function translateMulterError(err) {
  const messages = {
    LIMIT_FILE_SIZE: `حجم فایل بیشتر از حد مجاز (${env.upload.maxMb} مگابایت) است`,
    LIMIT_UNEXPECTED_FILE: 'فیلد فایل ارسالی نامعتبر است',
    LIMIT_FILE_COUNT: 'تعداد فایل‌های ارسالی بیشتر از حد مجاز است',
  };
  return ApiError.badRequest(messages[err.code] || 'خطا در آپلود فایل');
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let error = err;

  if (err.code && err.code.startsWith('P')) {
    error = translatePrismaError(err) || ApiError.internal('خطای پایگاه داده');
  } else if (err.name === 'MulterError') {
    error = translateMulterError(err);
  }

  if (!(error instanceof ApiError)) {
    logger.error(err);
    error = ApiError.internal(
      process.env.NODE_ENV === 'production' ? 'خطای داخلی سرور' : err.message
    );
  } else if (error.statusCode >= 500) {
    logger.error(err);
  }

  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message,
    details: error.details ?? undefined,
  });
}

module.exports = { notFoundHandler, errorHandler };
