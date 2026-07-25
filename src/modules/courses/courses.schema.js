import {
  objectIdParam,
  paginationQuery,
  query,
  searchQuery,
  slugParam,
  z,
} from '../../middleware/validate.js';
import { COURSE_SORTS } from './courses.service.js';

export const COURSE_FORMATS = ['web_course', 'training_seminar', 'tutorial', 'learning_path'];
export const COURSE_LEVELS = ['beginner', 'intermediate', 'advanced'];
export const COURSE_STATUSES = ['draft', 'published'];

export const courseSlugParams = z.object({ slug: slugParam });

export const courseLessonParams = z.object({
  slug: slugParam,
  lessonId: objectIdParam,
});

/** `sort` is an enum, never a raw Mongo expression (§4). */
const sortEnum = z.enum([...Object.keys(COURSE_SORTS), 'relevance']);

export const courseListQuery = query({
  ...paginationQuery,
  ...searchQuery,
  category: slugParam.optional(),
  format: z.enum(COURSE_FORMATS).optional(),
  level: z.enum(COURSE_LEVELS).optional(),
  access: z.enum(['free', 'premium']).optional(),
  sort: sortEnum.optional(),
});

export const featuredQuery = query({
  limit: z.coerce.number().int().min(1).max(24).default(6),
});

export const relatedQuery = query({
  limit: z.coerce.number().int().min(1).max(12).default(4),
});

export const reviewListQuery = query({
  ...paginationQuery,
  rating: z.coerce.number().int().min(1).max(5).optional(),
  sort: z.enum(['recent', 'oldest', 'highest', 'lowest']).optional(),
});
