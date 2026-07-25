import {
  dateRangeQuery,
  objectIdParam,
  paginationQuery,
  query,
  searchQuery,
  slugParam,
  strictObject,
  z,
} from '../../middleware/validate.js';
import { COURSE_FORMATS, COURSE_LEVELS, COURSE_STATUSES } from '../courses/courses.schema.js';
import { COURSE_SORTS } from '../courses/courses.service.js';

export const slugParams = z.object({ slug: slugParam });
export const idParams = z.object({ id: objectIdParam });
export const userIdParams = z.object({ userId: objectIdParam });
export const courseLessonParams = z.object({ slug: slugParam, id: objectIdParam });

const optionalUrl = z.union([z.url('Enter a valid URL'), z.literal('')]).optional();

// ---- courses ---------------------------------------------------------------

export const adminCourseListQuery = query({
  ...paginationQuery,
  ...searchQuery,
  category: slugParam.optional(),
  format: z.enum(COURSE_FORMATS).optional(),
  level: z.enum(COURSE_LEVELS).optional(),
  access: z.enum(['free', 'premium']).optional(),
  status: z.enum(COURSE_STATUSES).optional(),
  sort: z.enum([...Object.keys(COURSE_SORTS), 'relevance']).optional(),
});

const faqSchema = strictObject({
  question: z.string().trim().min(3).max(300),
  answer: z.string().trim().min(1).max(4000),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
});

const courseFields = {
  title: z.string().trim().min(3).max(160),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/i).max(90).optional(),
  summary: z.string().trim().max(400).optional(),
  description: z.array(z.string().trim().max(4000)).max(30).optional(),
  contentHTML: z.string().max(200_000).optional(),
  trackId: z.string().trim().min(1).max(90).optional(),
  instructorId: objectIdParam.optional(),
  format: z.enum(COURSE_FORMATS),
  level: z.enum(COURSE_LEVELS),
  premium: z.boolean().optional(),
  priceKES: z.coerce.number().int().min(0).max(10_000_000).nullable().optional(),
  originalPriceKES: z.coerce.number().int().min(0).max(10_000_000).nullable().optional(),
  featured: z.boolean().optional(),
  status: z.enum(COURSE_STATUSES).optional(),
  whatYouLearn: z.array(z.string().trim().max(400)).max(30).optional(),
  requirements: z.array(z.string().trim().max(400)).max(30).optional(),
  faqs: z.array(faqSchema).max(30).optional(),
};

export const createCourseBody = strictObject(courseFields);

export const updateCourseBody = strictObject({
  ...courseFields,
  title: courseFields.title.optional(),
  format: courseFields.format.optional(),
  level: courseFields.level.optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

// ---- lessons ---------------------------------------------------------------

const lessonFields = {
  title: z.string().trim().min(2).max(200),
  sectionTitle: z.string().trim().min(1).max(160).optional(),
  sectionOrder: z.coerce.number().int().min(0).max(999).optional(),
  minutes: z.coerce.number().int().min(0).max(6000).optional(),
  isPreview: z.boolean().optional(),
  videoUrl: optionalUrl,
  contentHTML: z.string().max(500_000).optional(),
  order: z.coerce.number().int().min(0).max(9999).optional(),
};

export const createLessonBody = strictObject(lessonFields);

export const updateLessonBody = strictObject({
  ...lessonFields,
  title: lessonFields.title.optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const reorderLessonsBody = strictObject({
  lessons: z
    .array(
      strictObject({
        id: objectIdParam,
        order: z.coerce.number().int().min(0).max(9999).optional(),
        sectionTitle: z.string().trim().min(1).max(160).optional(),
        sectionOrder: z.coerce.number().int().min(0).max(999).optional(),
      }),
    )
    .min(1)
    .max(500),
});

// ---- people & ledger -------------------------------------------------------

export const rosterQuery = query({
  ...paginationQuery,
  ...searchQuery,
  status: z.enum(['active', 'completed']).optional(),
  sort: z.enum(['recent', 'progress', 'oldest']).optional(),
});

export const learnersQuery = query({
  ...paginationQuery,
  ...searchQuery,
  ...dateRangeQuery,
  role: z.enum(['learner', 'instructor', 'admin']).optional(),
  sort: z.enum(['recent', 'az', 'za']).optional(),
});

export const updateRoleBody = strictObject({
  role: z.enum(['learner', 'instructor', 'admin']),
});

export const moderationQuery = query({
  ...paginationQuery,
  rating: z.coerce.number().int().min(1).max(5).optional(),
  courseId: objectIdParam.optional(),
  sort: z.enum(['recent', 'oldest', 'lowest', 'highest']).optional(),
});

export const paymentsQuery = query({
  ...paginationQuery,
  ...dateRangeQuery,
  status: z.enum(['pending', 'paid', 'failed', 'refunded', 'abandoned']).optional(),
  channel: z.string().trim().max(40).optional(),
  course: slugParam.optional(),
  sort: z.enum(['recent', 'oldest', 'amountHigh', 'amountLow']).optional(),
});

export const refundBody = strictObject({
  reason: z.string().trim().max(400).optional(),
});
