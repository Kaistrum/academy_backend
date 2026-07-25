import { ZodError } from 'zod';
import env from '../config/env.js';
import ApiError from '../lib/apiError.js';
import { sendError } from '../utils/response.js';

export function notFound(req, res) {
  return sendError(res, 404, 'ROUTE_NOT_FOUND', `Cannot ${req.method} ${req.originalUrl}`);
}

/** Maps every thrown value onto the `{ error: { code, message, fields? } }` envelope (§1). */
export function errorHandler(err, req, res, _next) {
  if (res.headersSent) return;

  if (err instanceof ApiError) {
    if (err.status >= 500) console.error(err);
    const body = { code: err.code, message: err.message };
    if (err.fields) body.fields = err.fields;
    // 402 carries the checkout hand-off for premium courses (§6.6).
    if (err.checkout) body.checkout = err.checkout;
    return res.status(err.status).json({ error: body });
  }

  if (err instanceof ZodError) {
    const fields = {};
    for (const issue of err.issues) fields[issue.path.join('.') || 'body'] = issue.message;
    return sendError(res, 422, 'VALIDATION_ERROR', 'Some fields are invalid', fields);
  }

  // Duplicate key — the unique indexes are the real guard, this makes it readable.
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {}).join(', ') || 'record';
    return sendError(res, 409, 'DUPLICATE_KEY', `A record with this ${field} already exists`);
  }

  if (err?.type === 'entity.too.large') {
    return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }

  if (err?.type === 'entity.parse.failed') {
    return sendError(res, 400, 'INVALID_JSON', 'Request body is not valid JSON');
  }

  if (err?.message === 'CORS_NOT_ALLOWED') {
    return sendError(res, 403, 'CORS_NOT_ALLOWED', 'Origin is not allowed');
  }

  console.error('Unhandled error:', err);
  return sendError(
    res,
    500,
    'INTERNAL_ERROR',
    env.isProd ? 'Something went wrong' : (err?.message ?? 'Something went wrong'),
  );
}
