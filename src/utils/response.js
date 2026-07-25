/** Envelope helpers — §1 of the design doc. */

export function sendData(res, data, status = 200) {
  return res.status(status).json({ data });
}

export function sendList(res, data, meta, status = 200) {
  return res.status(status).json({ data, meta });
}

export function sendError(res, status, code, message, fields) {
  const error = { code, message };
  if (fields) error.fields = fields;
  return res.status(status).json({ error });
}

export function buildMeta({ page, pageSize, total }) {
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
  return {
    page,
    pageSize,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1 && total > 0,
  };
}
