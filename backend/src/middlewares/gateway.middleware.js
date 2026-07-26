const crypto = require('crypto');
const env = require('../config/env');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

/**
 * Verifies the payment-gateway callback is actually from the gateway, not
 * forged by an attacker who simply knows (or guesses) a transactionRef.
 *
 * This is a generic HMAC-SHA256-over-the-raw-body scheme, signed with a
 * secret shared out-of-band with the gateway (GATEWAY_CALLBACK_SECRET) and
 * sent back by the gateway in an `x-gateway-signature` header. Every real
 * provider (ZarinPal, IDPay, Stripe, ...) has its own concrete signing
 * mechanism — swap the comparison below for the provider's actual scheme
 * once one is chosen; the important, non-negotiable part is that SOME
 * verification runs here before a callback is ever trusted.
 *
 * Fails CLOSED: if no secret is configured (e.g. local dev with no gateway
 * wired up yet), every callback is rejected rather than silently accepted.
 */
function verifyGatewaySignature(req, res, next) {
  if (!env.gateway.callbackSecret) {
    logger.error('Gateway callback rejected: GATEWAY_CALLBACK_SECRET is not configured');
    return next(ApiError.internal('درگاه پرداخت پیکربندی نشده است'));
  }

  const signature = req.headers['x-gateway-signature'];
  if (!signature || typeof signature !== 'string') {
    return next(ApiError.unauthorized('امضای درخواست ارسال نشده است'));
  }

  const expected = crypto
    .createHmac('sha256', env.gateway.callbackSecret)
    .update(req.rawBody || Buffer.from(JSON.stringify(req.body || {})))
    .digest('hex');

  const provided = Buffer.from(signature, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const valid = provided.length === expectedBuf.length && crypto.timingSafeEqual(provided, expectedBuf);

  if (!valid) {
    logger.warn('Gateway callback rejected: invalid signature');
    return next(ApiError.unauthorized('امضای درخواست نامعتبر است'));
  }

  next();
}

module.exports = { verifyGatewaySignature };
