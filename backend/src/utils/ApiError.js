/**
 * Standard application error. Every intentional failure (validation,
 * not found, forbidden, conflict, ...) should throw this so the central
 * error middleware can turn it into a consistent JSON response.
 */
class ApiError extends Error {
  constructor(statusCode, message, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, details) { return new ApiError(400, message, details); }
  static unauthorized(message = 'احراز هویت انجام نشده است') { return new ApiError(401, message); }
  static forbidden(message = 'دسترسی مجاز نیست') { return new ApiError(403, message); }
  static notFound(message = 'مورد یافت نشد') { return new ApiError(404, message); }
  static conflict(message = 'تداخل داده‌ای') { return new ApiError(409, message); }
  static internal(message = 'خطای داخلی سرور') { return new ApiError(500, message); }
}

module.exports = ApiError;
