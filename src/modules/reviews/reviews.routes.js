import { Router } from 'express';
import asyncHandler from '../../lib/asyncHandler.js';
import { recordAudit } from '../../lib/audit.js';
import { requireAuth } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import { objectIdParam, slugParam, strictObject, validate, z } from '../../middleware/validate.js';
import { sendData } from '../../utils/response.js';
import { createReview, deleteReview, updateReview } from './reviews.service.js';

const router = Router();

const createReviewBody = strictObject({
  rating: z.coerce.number().int().min(1).max(5),
  body: z.string().trim().min(10, 'Tell us a little more — at least 10 characters').max(4000),
});

const updateReviewBody = strictObject({
  rating: z.coerce.number().int().min(1).max(5).optional(),
  body: z.string().trim().min(10).max(4000).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Provide a rating or a review body' });

router.post(
  '/courses/:slug/reviews',
  requireAuth,
  writeLimiter,
  validate({ params: z.object({ slug: slugParam }), body: createReviewBody }),
  asyncHandler(async (req, res) =>
    sendData(res, await createReview(req.valid.params.slug, req.user, req.valid.body), 201),
  ),
);

router.patch(
  '/reviews/:id',
  requireAuth,
  writeLimiter,
  validate({ params: z.object({ id: objectIdParam }), body: updateReviewBody }),
  asyncHandler(async (req, res) =>
    sendData(res, await updateReview(req.valid.params.id, req.user, req.valid.body)),
  ),
);

router.delete(
  '/reviews/:id',
  requireAuth,
  writeLimiter,
  validate({ params: z.object({ id: objectIdParam }) }),
  asyncHandler(async (req, res) => {
    const result = await deleteReview(req.valid.params.id, req.user);
    if (result.moderated) {
      await recordAudit(req, {
        action: 'review.moderate',
        targetType: 'review',
        targetId: result.id,
      });
    }
    return sendData(res, result);
  }),
);

export default router;
