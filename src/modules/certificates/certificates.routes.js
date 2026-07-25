import { Router } from 'express';
import asyncHandler from '../../lib/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import {
  objectIdParam,
  paginationQuery,
  query,
  slugParam,
  validate,
  z,
} from '../../middleware/validate.js';
import { sendData, sendList } from '../../utils/response.js';
import {
  getCertificate,
  issueCertificate,
  listMyCertificates,
  renderCertificate,
  verifyCertificate,
} from './certificates.service.js';

const router = Router();

const idParams = z.object({ id: objectIdParam });
const downloadQuery = query({ format: z.enum(['svg', 'pdf']).default('svg') });

router.get(
  '/me/certificates',
  requireAuth,
  validate({ query: query(paginationQuery) }),
  asyncHandler(async (req, res) => {
    const { data, meta } = await listMyCertificates(req.user._id, req.valid.query);
    return sendList(res, data, meta);
  }),
);

router.post(
  '/courses/:slug/certificate',
  requireAuth,
  writeLimiter,
  validate({ params: z.object({ slug: slugParam }) }),
  asyncHandler(async (req, res) => {
    const result = await issueCertificate(req.valid.params.slug, req.user);
    return sendData(res, result.certificate, result.alreadyIssued ? 200 : 201);
  }),
);

// Registered before `/certificates/:id` so "verify" is not read as an id.
router.get(
  '/certificates/verify/:serial',
  validate({
    params: z.object({ serial: z.string().trim().min(4).max(40).regex(/^[A-Za-z0-9-]+$/) }),
  }),
  asyncHandler(async (req, res) =>
    sendData(res, await verifyCertificate(req.valid.params.serial)),
  ),
);

router.get(
  '/certificates/:id',
  requireAuth,
  validate({ params: idParams }),
  asyncHandler(async (req, res) =>
    sendData(res, await getCertificate(req.valid.params.id, req.user)),
  ),
);

router.get(
  '/certificates/:id/download',
  requireAuth,
  validate({ params: idParams, query: downloadQuery }),
  asyncHandler(async (req, res) => {
    const file = await renderCertificate(
      req.valid.params.id,
      req.user,
      req.valid.query.format,
    );
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    return res.send(file.body);
  }),
);

export default router;
