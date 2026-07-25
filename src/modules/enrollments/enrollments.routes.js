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
  enrollInCourse,
  getEnrollmentForCourse,
  listMyEnrollments,
  markLessonComplete,
  unenroll,
} from './enrollments.service.js';

const router = Router();

const myEnrollmentsQuery = query({
  ...paginationQuery,
  status: z.enum(['active', 'completed']).optional(),
  sort: z.enum(['recent', 'enrolled', 'progress']).optional(),
});

const slugParams = z.object({ slug: slugParam });
const lessonProgressParams = z.object({ id: objectIdParam, lessonId: objectIdParam });

router.get(
  '/me/enrollments',
  requireAuth,
  validate({ query: myEnrollmentsQuery }),
  asyncHandler(async (req, res) => {
    const { data, meta } = await listMyEnrollments(req.user._id, req.valid.query);
    return sendList(res, data, meta);
  }),
);

router.post(
  '/courses/:slug/enroll',
  requireAuth,
  writeLimiter,
  validate({ params: slugParams }),
  asyncHandler(async (req, res) => {
    const result = await enrollInCourse(req.valid.params.slug, req.user);
    return sendData(res, result, result.alreadyEnrolled ? 200 : 201);
  }),
);

router.get(
  '/courses/:slug/enrollment',
  requireAuth,
  validate({ params: slugParams }),
  asyncHandler(async (req, res) =>
    sendData(res, await getEnrollmentForCourse(req.valid.params.slug, req.user)),
  ),
);

router.put(
  '/enrollments/:id/lessons/:lessonId/complete',
  requireAuth,
  validate({ params: lessonProgressParams }),
  asyncHandler(async (req, res) => {
    const { id, lessonId } = req.valid.params;
    return sendData(res, await markLessonComplete(id, lessonId, req.user, { completed: true }));
  }),
);

// Lets the player toggle a lesson back to unfinished.
router.delete(
  '/enrollments/:id/lessons/:lessonId/complete',
  requireAuth,
  validate({ params: lessonProgressParams }),
  asyncHandler(async (req, res) => {
    const { id, lessonId } = req.valid.params;
    return sendData(res, await markLessonComplete(id, lessonId, req.user, { completed: false }));
  }),
);

router.delete(
  '/enrollments/:id',
  requireAuth,
  writeLimiter,
  validate({ params: z.object({ id: objectIdParam }) }),
  asyncHandler(async (req, res) => sendData(res, await unenroll(req.valid.params.id, req.user))),
);

export default router;
