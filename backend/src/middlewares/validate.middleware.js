const ApiError = require('../utils/ApiError');

/**
 * Validates req.body / req.query / req.params against a Zod schema map:
 *   validate({ body: createProductSchema })
 * On failure, throws a 400 ApiError with field-level details instead of
 * letting bad input reach the service/controller layer.
 */
function validate(schemas) {
  return (req, res, next) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) req.query = schemas.query.parse(req.query);
      if (schemas.params) req.params = schemas.params.parse(req.params);
      next();
    } catch (err) {
      const details = err.errors?.map((e) => ({ path: e.path.join('.'), message: e.message }));
      next(ApiError.badRequest('داده ورودی نامعتبر است', details || err.message));
    }
  };
}

module.exports = validate;
