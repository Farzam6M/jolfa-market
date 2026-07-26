/**
 * Uniform success envelope for every endpoint:
 * { success: true, message, data, meta }
 */
class ApiResponse {
  constructor(data = null, message = 'OK', meta = undefined) {
    this.success = true;
    this.message = message;
    this.data = data;
    if (meta) this.meta = meta;
  }
}

module.exports = ApiResponse;
