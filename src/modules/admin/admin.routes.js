import { Router } from 'express';
import asyncHandler from '../../lib/asyncHandler.js';
import { recordAudit } from '../../lib/audit.js';
import { requireAdmin, requireAuth, requireStaff } from '../../middleware/auth.js';
import { loadOwnedCourse, ownershipFilter } from '../../middleware/ownCourse.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { sendData, sendList } from '../../utils/response.js';
import { buildInstructorsRouter } from '../instructors/instructors.routes.js';
import { listPayments, refundPayment } from '../payments/payments.service.js';
import { deleteReview, listReviewsForModeration } from '../reviews/reviews.service.js';
import { buildTracksRouter } from '../tracks/tracks.routes.js';
import * as schema from './admin.schema.js';
import {
  getCourseRoster,
  getLearnerDetail,
  getOverview,
  listLearners,
  updateLearnerRole,
} from './admin.service.js';
import {
  createCourse,
  createLesson,
  deleteCourse,
  deleteLesson,
  getAdminCourse,
  getLessonForEdit,
  listAdminCourses,
  listCourseLessons,
  reorderLessons,
  updateCourse,
  updateLesson,
} from './courses.admin.service.js';

const router = Router();

// Everything under /admin needs a signed-in staff account; individual routes
// tighten that to admin-only where the design doc marks them 👑.
router.use('/admin', requireAuth, requireStaff);

// ---- dashboard -------------------------------------------------------------

router.get(
  '/admin/overview',
  asyncHandler(async (req, res) => sendData(res, await getOverview(req.user))),
);

// ---- courses ---------------------------------------------------------------

router.get(
  '/admin/courses',
  validate({ query: schema.adminCourseListQuery }),
  asyncHandler(async (req, res) => {
    const { data, meta } = await listAdminCourses(req.valid.query, req.user);
    return sendList(res, data, meta);
  }),
);

router.post(
  '/admin/courses',
  writeLimiter,
  validate({ body: schema.createCourseBody }),
  asyncHandler(async (req, res) => {
    const course = await createCourse(req.valid.body, req.user);
    await recordAudit(req, { action: 'course.create', targetType: 'course', targetId: course.id });
    return sendData(res, course, 201);
  }),
);

router.get(
  '/admin/courses/:slug',
  validate({ params: schema.slugParams }),
  loadOwnedCourse(),
  asyncHandler(async (req, res) => sendData(res, await getAdminCourse(req.course.slug))),
);

router.patch(
  '/admin/courses/:slug',
  writeLimiter,
  validate({ params: schema.slugParams, body: schema.updateCourseBody }),
  loadOwnedCourse(),
  asyncHandler(async (req, res) => {
    const course = await updateCourse(req.course, req.valid.body, req.user);
    await recordAudit(req, {
      action: req.valid.body.status ? `course.${req.valid.body.status}` : 'course.update',
      targetType: 'course',
      targetId: course.id,
      meta: { slug: course.slug },
    });
    return sendData(res, course);
  }),
);

router.delete(
  '/admin/courses/:slug',
  writeLimiter,
  validate({ params: schema.slugParams }),
  loadOwnedCourse(),
  asyncHandler(async (req, res) => {
    const result = await deleteCourse(req.course);
    await recordAudit(req, {
      action: 'course.delete',
      targetType: 'course',
      targetId: result.id,
      meta: { slug: result.slug },
    });
    return sendData(res, result);
  }),
);

// ---- lessons ---------------------------------------------------------------

router.get(
  '/admin/courses/:slug/lessons',
  validate({ params: schema.slugParams }),
  loadOwnedCourse(),
  asyncHandler(async (req, res) => sendData(res, await listCourseLessons(req.course))),
);

router.post(
  '/admin/courses/:slug/lessons',
  writeLimiter,
  validate({ params: schema.slugParams, body: schema.createLessonBody }),
  loadOwnedCourse(),
  asyncHandler(async (req, res) => {
    const lesson = await createLesson(req.course, req.valid.body);
    await recordAudit(req, { action: 'lesson.create', targetType: 'lesson', targetId: lesson.id });
    return sendData(res, lesson, 201);
  }),
);

// Registered before `/lessons/:id` so "reorder" is not parsed as an id.
router.patch(
  '/admin/courses/:slug/lessons/reorder',
  writeLimiter,
  validate({ params: schema.slugParams, body: schema.reorderLessonsBody }),
  loadOwnedCourse(),
  asyncHandler(async (req, res) =>
    sendData(res, await reorderLessons(req.course, req.valid.body.lessons)),
  ),
);

router.get(
  '/admin/courses/:slug/lessons/:id',
  validate({ params: schema.courseLessonParams }),
  loadOwnedCourse(),
  asyncHandler(async (req, res) =>
    sendData(res, await getLessonForEdit(req.course, req.valid.params.id)),
  ),
);

router.patch(
  '/admin/courses/:slug/lessons/:id',
  writeLimiter,
  validate({ params: schema.courseLessonParams, body: schema.updateLessonBody }),
  loadOwnedCourse(),
  asyncHandler(async (req, res) =>
    sendData(res, await updateLesson(req.course, req.valid.params.id, req.valid.body)),
  ),
);

router.delete(
  '/admin/courses/:slug/lessons/:id',
  writeLimiter,
  validate({ params: schema.courseLessonParams }),
  loadOwnedCourse(),
  asyncHandler(async (req, res) => {
    const result = await deleteLesson(req.course, req.valid.params.id);
    await recordAudit(req, { action: 'lesson.delete', targetType: 'lesson', targetId: result.id });
    return sendData(res, result);
  }),
);

// ---- learners --------------------------------------------------------------

router.get(
  '/admin/courses/:slug/learners',
  validate({ params: schema.slugParams, query: schema.rosterQuery }),
  loadOwnedCourse(),
  asyncHandler(async (req, res) => {
    const { data, meta } = await getCourseRoster(req.course, req.valid.query);
    return sendList(res, data, meta);
  }),
);

router.get(
  '/admin/learners',
  requireAdmin,
  validate({ query: schema.learnersQuery }),
  asyncHandler(async (req, res) => {
    const { data, meta } = await listLearners(req.valid.query);
    return sendList(res, data, meta);
  }),
);

router.get(
  '/admin/learners/:userId',
  requireAdmin,
  validate({ params: schema.userIdParams }),
  asyncHandler(async (req, res) => sendData(res, await getLearnerDetail(req.valid.params.userId))),
);

router.patch(
  '/admin/learners/:userId/role',
  requireAdmin,
  writeLimiter,
  validate({ params: schema.userIdParams, body: schema.updateRoleBody }),
  asyncHandler(async (req, res) => {
    const user = await updateLearnerRole(req.valid.params.userId, req.valid.body.role);
    await recordAudit(req, {
      action: 'user.role_change',
      targetType: 'user',
      targetId: user.id,
      meta: { role: req.valid.body.role },
    });
    return sendData(res, user);
  }),
);

// ---- review moderation -----------------------------------------------------

router.get(
  '/admin/reviews',
  validate({ query: schema.moderationQuery }),
  asyncHandler(async (req, res) => {
    const scope = ownershipFilter(req.user);
    const { data, meta } = await listReviewsForModeration(req.valid.query, req.user, {
      courseScope: scope.instructorId ? scope : null,
    });
    return sendList(res, data, meta);
  }),
);

router.delete(
  '/admin/reviews/:id',
  writeLimiter,
  validate({ params: schema.idParams }),
  asyncHandler(async (req, res) => {
    const result = await deleteReview(req.valid.params.id, req.user);
    await recordAudit(req, {
      action: 'review.moderate',
      targetType: 'review',
      targetId: result.id,
    });
    return sendData(res, result);
  }),
);

// ---- payments --------------------------------------------------------------

router.get(
  '/admin/payments',
  validate({ query: schema.paymentsQuery }),
  asyncHandler(async (req, res) => {
    const { data, meta, summary } = await listPayments(req.valid.query, req.user);
    return res.json({ data, meta, summary });
  }),
);

router.post(
  '/admin/payments/:id/refund',
  requireAdmin,
  writeLimiter,
  validate({ params: schema.idParams, body: schema.refundBody }),
  asyncHandler(async (req, res) => {
    const payment = await refundPayment(req.valid.params.id, req.valid.body);
    await recordAudit(req, {
      action: 'payment.refund',
      targetType: 'payment',
      targetId: payment.id,
      meta: { reference: payment.reference, amountKES: payment.amountKES },
    });
    return sendData(res, payment);
  }),
);

// Tutor and track management reuse the same routers as the public modules,
// remounted under the admin prefixes the panel calls (§6.11).
router.use(buildInstructorsRouter({ basePath: '/admin/tutors', publicRoutes: false }));
router.use(buildTracksRouter({ basePath: '/admin/tracks' }));

export default router;
