import { z } from 'zod';
import ApiError from '../lib/apiError.js';

/**
 * Parses `body`, `query` and `params` against Zod schemas and publishes the
 * results on `req.valid`. Handlers read `req.valid.query` rather than
 * `req.query`, which means only allow-listed, coerced values ever reach a
 * service — and it sidesteps Express 5's read-only `req.query` getter.
 */
export function validate(schemas) {
  return (req, _res, next) => {
    const fields = {};
    const valid = {};

    for (const source of ['body', 'query', 'params']) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source] ?? {});
      if (result.success) {
        valid[source] = result.data;
      } else {
        for (const issue of result.error.issues) {
          const key = issue.path.join('.') || source;
          if (!fields[key]) fields[key] = issue.message;
        }
      }
    }

    if (Object.keys(fields).length > 0) {
      return next(ApiError.unprocessable('Some fields are invalid', fields));
    }

    req.valid = { body: {}, query: {}, params: {}, ...valid };
    return next();
  };
}

// ---- shared building blocks ------------------------------------------------

export const objectIdParam = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'Must be a valid id');

export const slugParam = z
  .string()
  .min(1)
  .max(90)
  .regex(/^[a-z0-9-]+$/i, 'Must be a valid slug');

/**
 * Paging is clamped rather than rejected (§5): a client asking for
 * `pageSize=500` gets 100 back, not a 422. `clampPaging` repeats the bounds at
 * the query layer so a service called directly is protected too.
 */
export const paginationQuery = {
  page: z.coerce
    .number()
    .int()
    .catch(1)
    .transform((v) => Math.max(1, v))
    .default(1),
  pageSize: z.coerce
    .number()
    .int()
    .catch(12)
    .transform((v) => Math.min(100, Math.max(1, v)))
    .default(12),
};

export const searchQuery = {
  q: z.string().trim().min(1).max(120).optional(),
};

export const dateRangeQuery = {
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
};

/** Rejects unknown keys so a stray `$where` can never survive validation. */
export const strictObject = (shape) => z.object(shape).strict();

/** Query objects tolerate unknown params (§1: "unknown params are ignored"). */
export const query = (shape) => z.object(shape).strip();

export { z };
