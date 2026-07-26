const logger = require('./logger');

/**
 * Mock SMS provider. Replace the body of this function with a real
 * gateway integration (Kavenegar, Twilio, ...) — every caller in the
 * codebase already goes through this single choke point.
 */
async function sendSms(mobile, message) {
  logger.info(`[MOCK SMS] to=${mobile} :: ${message}`);
  return { success: true, provider: 'mock' };
}

/**
 * Mock email provider. Replace the body of this function with a real
 * provider integration (SendGrid, SES, ...) — every caller in the
 * codebase already goes through this single choke point.
 */
async function sendEmail(email, subject, message) {
  logger.info(`[MOCK EMAIL] to=${email} subject="${subject}" :: ${message}`);
  return { success: true, provider: 'mock' };
}

module.exports = { sendSms, sendEmail };
