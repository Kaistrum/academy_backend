import { Router } from 'express';
import asyncHandler from '../../lib/asyncHandler.js';
import { recordAudit } from '../../lib/audit.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { sendData } from '../../utils/response.js';
import * as schema from './tracks.schema.js';
import {
  createTrack,
  deleteTrack,
  getTrackBySlug,
  listTracks,
  updateTrack,
} from './tracks.service.js';

/**
 * Mounted twice — at `/tracks` for the public catalogue and at `/admin/tracks`
 * for the back office (§6.3, §6.11). The admin verbs are identical, so the
 * router is built once and reused under both prefixes.
 */
export function buildTracksRouter({ basePath = '/tracks' } = {}) {
  const router = Router();

  router.get(
    basePath,
    asyncHandler(async (_req, res) => sendData(res, await listTracks())),
  );

  router.get(
    `${basePath}/:slug`,
    validate({ params: schema.trackSlugParams }),
    asyncHandler(async (req, res) => sendData(res, await getTrackBySlug(req.valid.params.slug))),
  );

  router.post(
    basePath,
    requireAuth,
    requireAdmin,
    writeLimiter,
    validate({ body: schema.createTrackBody }),
    asyncHandler(async (req, res) => {
      const track = await createTrack(req.valid.body);
      await recordAudit(req, { action: 'track.create', targetType: 'track', targetId: track.id });
      return sendData(res, track, 201);
    }),
  );

  router.patch(
    `${basePath}/:slug`,
    requireAuth,
    requireAdmin,
    writeLimiter,
    validate({ params: schema.trackSlugParams, body: schema.updateTrackBody }),
    asyncHandler(async (req, res) => {
      const track = await updateTrack(req.valid.params.slug, req.valid.body);
      await recordAudit(req, { action: 'track.update', targetType: 'track', targetId: track.id });
      return sendData(res, track);
    }),
  );

  router.delete(
    `${basePath}/:slug`,
    requireAuth,
    requireAdmin,
    writeLimiter,
    validate({ params: schema.trackSlugParams }),
    asyncHandler(async (req, res) => {
      const result = await deleteTrack(req.valid.params.slug);
      await recordAudit(req, {
        action: 'track.delete',
        targetType: 'track',
        targetId: result.id,
        meta: { slug: req.valid.params.slug },
      });
      return sendData(res, result);
    }),
  );

  return router;
}

export default buildTracksRouter();
