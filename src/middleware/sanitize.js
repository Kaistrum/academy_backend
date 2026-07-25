const MAX_DEPTH = 12;

/**
 * Strips keys that Mongo would read as operators (`$gt`) or as dotted paths
 * (`a.b`). Validation already allow-lists every field we consume, so this is a
 * second line of defence for anything that reaches a query builder (§5).
 */
function scrub(value, depth = 0) {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) value[i] = scrub(value[i], depth + 1);
    return value;
  }

  for (const key of Object.keys(value)) {
    if (key.startsWith('$') || key.includes('.') || key === '__proto__') {
      delete value[key];
    } else {
      value[key] = scrub(value[key], depth + 1);
    }
  }
  return value;
}

export function sanitize(req, _res, next) {
  if (req.body) scrub(req.body);
  if (req.params) scrub(req.params);

  // Express 5 exposes `req.query` through a memoising getter, so it cannot be
  // reassigned — mutate the object that getter returns instead.
  try {
    const q = req.query;
    if (q && typeof q === 'object') scrub(q);
  } catch {
    /* query not parseable — the validator will reject it anyway */
  }

  next();
}

export default sanitize;
