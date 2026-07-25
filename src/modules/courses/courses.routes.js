import { Router } from 'express';
import asyncHandler from '../../lib/asyncHandler.js';
import { optionalAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { sendData, sendList } from '../../utils/response.js';
import * as schema from './courses.schema.js';
import {
  getCourseDetail,
  getCourseReviews,
  getCurriculum,
  getLesson,
  getRelatedCourses,
  listFeaturedCourses,
  listPublishedCourses,
} from './courses.service.js';

const router = Router();

router.get(
  '/courses',
  validate({ query: schema.courseListQuery }),
  asyncHandler(async (req, res) => {
    const { data, meta } = await listPublishedCourses(req.valid.query);
    return sendList(res, data, meta);
  }),
);

// Registered before `/courses/:slug` so "featured" is never read as a slug.
router.get(
  '/courses/featured',
  validate({ query: schema.featuredQuery }),
  asyncHandler(async (req, res) =>
    sendData(res, await listFeaturedCourses({ limit: req.valid.query.limit })),
  ),
);

router.get(
  '/courses/:slug',
  optionalAuth,
  validate({ params: schema.courseSlugParams }),
  asyncHandler(async (req, res) =>
    sendData(res, await getCourseDetail(req.valid.params.slug, req.user)),
  ),
);

router.get(
  '/courses/:slug/related',
  validate({ params: schema.courseSlugParams, query: schema.relatedQuery }),
  asyncHandler(async (req, res) =>
    sendData(res, await getRelatedCourses(req.valid.params.slug, req.valid.query)),
  ),
);

router.get(
  '/courses/:slug/curriculum',
  optionalAuth,
  validate({ params: schema.courseSlugParams }),
  asyncHandler(async (req, res) =>
    sendData(res, await getCurriculum(req.valid.params.slug, req.user)),
  ),
);

router.get(
  '/courses/:slug/lessons/:lessonId',
  optionalAuth,
  validate({ params: schema.courseLessonParams }),
  asyncHandler(async (req, res) => {
    const { slug, lessonId } = req.valid.params;
    return sendData(res, await getLesson(slug, lessonId, req.user));
  }),
);

router.get(
  '/courses/:slug/reviews',
  validate({ params: schema.courseSlugParams, query: schema.reviewListQuery }),
  asyncHandler(async (req, res) => {
    const { data, meta, summary } = await getCourseReviews(
      req.valid.params.slug,
      req.valid.query,
    );
    // List envelope plus the rating summary the detail page renders alongside it.
    return res.json({ data, meta, summary });
  }),
);

export default router;
