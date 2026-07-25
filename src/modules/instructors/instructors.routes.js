import { Router } from 'express';
import asyncHandler from '../../lib/asyncHandler.js';
import { recordAudit } from '../../lib/audit.js';
import { requireAdmin, requireAuth, requireStaff } from '../../middleware/auth.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { sendData, sendList } from '../../utils/response.js';
import { courseListQuery } from '../courses/courses.schema.js';
import * as schema from './instructors.schema.js';
import {
  createInstructor,
  deleteInstructor,
  getInstructor,
  getInstructorCourses,
  listInstructors,
  updateInstructor,
} from './instructors.service.js';

/**
 * Mounted at `/instructors` (public card + staff list) and again at
 * `/admin/tutors` for the tutor-management screen (§6.4, §6.11).
 */
export function buildInstructorsRouter({ basePath = '/instructors', publicRoutes = true } = {}) {
  const router = Router();

  if (publicRoutes) {
    router.get(
      `${basePath}/:id`,
      validate({ params: schema.instructorIdParams }),
      asyncHandler(async (req, res) => sendData(res, await getInstructor(req.valid.params.id))),
    );

    router.get(
      `${basePath}/:id/courses`,
      validate({ params: schema.instructorIdParams, query: courseListQuery }),
      asyncHandler(async (req, res) => {
        const { data, meta } = await getInstructorCourses(req.valid.params.id, req.valid.query);
        return sendList(res, data, meta);
      }),
    );
  }

  router.get(
    basePath,
    requireAuth,
    requireStaff,
    validate({ query: schema.instructorListQuery }),
    asyncHandler(async (req, res) => {
      const { data, meta } = await listInstructors(req.valid.query, req.user);
      return sendList(res, data, meta);
    }),
  );

  router.post(
    basePath,
    requireAuth,
    requireAdmin,
    writeLimiter,
    validate({ body: schema.createInstructorBody }),
    asyncHandler(async (req, res) => {
      const instructor = await createInstructor(req.valid.body);
      await recordAudit(req, {
        action: 'instructor.create',
        targetType: 'instructor',
        targetId: instructor.id,
      });
      return sendData(res, instructor, 201);
    }),
  );

  router.patch(
    `${basePath}/:id`,
    requireAuth,
    requireAdmin,
    writeLimiter,
    validate({ params: schema.instructorIdParams, body: schema.updateInstructorBody }),
    asyncHandler(async (req, res) => {
      const instructor = await updateInstructor(req.valid.params.id, req.valid.body);
      await recordAudit(req, {
        action: 'instructor.update',
        targetType: 'instructor',
        targetId: instructor.id,
      });
      return sendData(res, instructor);
    }),
  );

  router.delete(
    `${basePath}/:id`,
    requireAuth,
    requireAdmin,
    writeLimiter,
    validate({ params: schema.instructorIdParams }),
    asyncHandler(async (req, res) => {
      const result = await deleteInstructor(req.valid.params.id);
      await recordAudit(req, {
        action: 'instructor.delete',
        targetType: 'instructor',
        targetId: result.id,
      });
      return sendData(res, result);
    }),
  );

  return router;
}

export default buildInstructorsRouter();
