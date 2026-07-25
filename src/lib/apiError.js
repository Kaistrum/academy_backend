/**
 * Error that maps straight onto the `{ error: { code, message, fields? } }`
 * envelope. Anything thrown that is not an ApiError becomes a 500.
 */
export class ApiError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (fields) this.fields = fields;
  }

  static badRequest(message = 'Invalid request', fields) {
    return new ApiError(400, 'BAD_REQUEST', message, fields);
  }

  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new ApiError(401, code, message);
  }

  static forbidden(message = 'You do not have access to this resource', code = 'FORBIDDEN') {
    return new ApiError(403, code, message);
  }

  static notFound(message = 'Resource not found', code = 'NOT_FOUND') {
    return new ApiError(404, code, message);
  }

  static conflict(message = 'Resource already exists', code = 'CONFLICT') {
    return new ApiError(409, code, message);
  }

  static unprocessable(message = 'Validation failed', fields) {
    return new ApiError(422, 'VALIDATION_ERROR', message, fields);
  }

  static paymentRequired(message = 'Payment required', extra = {}) {
    const err = new ApiError(402, 'PAYMENT_REQUIRED', message);
    Object.assign(err, extra);
    return err;
  }

  static tooManyRequests(message = 'Too many requests') {
    return new ApiError(429, 'RATE_LIMITED', message);
  }

  static internal(message = 'Something went wrong') {
    return new ApiError(500, 'INTERNAL_ERROR', message);
  }
}

export default ApiError;
