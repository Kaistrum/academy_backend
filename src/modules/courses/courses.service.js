import {
  Courses,
  Enrollments,
  Favourites,
  Instructors,
  Lessons,
  Reviews,
  Tracks,
  Users,
} from '../../db/collections.js';
import ApiError from '../../lib/apiError.js';
import { toObjectId } from '../../lib/ids.js';
import { clampPaging, paginate, resolveSort } from '../../lib/listQuery.js';
import {
  COURSE_CARD_PROJECTION,
  courseCard,
  courseDetail,
  indexById,
  lessonDetail,
  lessonSummary,
  publicEnrollment,
  publicReview,
} from '../../lib/shape.js';
import { buildMeta } from '../../utils/response.js';

/** Whitelisted sorts (§4). Anything else falls back to `recent`. */
export const COURSE_SORTS = {
  recent: { publishedAt: -1 },
  newest: { createdAt: -1 },
  rating: { ratingAvg: -1, ratingCount: -1 },
  popular: { learnersCount: -1 },
  az: { title: 1 },
  za: { title: -1 },
  shortest: { durationMinutes: 1 },
  longest: { durationMinutes: -1 },
  priceLow: { priceKES: 1 },
  priceHigh: { priceKES: -1 },
};

/**
 * Turns validated query params into a Mongo filter. Every value here has
 * already passed an allow-list, so nothing user-supplied reaches Mongo raw.
 */
async function buildCourseFilter({
  q,
  category,
  format,
  level,
  access,
  status,
  featured,
  instructorId,
  trackId,
}) {
  const filter = {};

  if (status) filter.status = status;
  if (format) filter.format = format;
  if (level) filter.level = level;
  if (featured !== undefined) filter.featured = featured;
  if (instructorId) filter.instructorId = instructorId;
  if (trackId) filter.trackId = trackId;

  if (access === 'free') filter.premium = false;
  if (access === 'premium') filter.premium = true;

  if (category) {
    const track = await Tracks().findOne({ slug: category }, { projection: { _id: 1 } });
    // An unknown category must return nothing, not silently ignore the filter.
    filter.trackId = track ? track._id : null;
  }

  if (q) filter.$text = { $search: q };

  return filter;
}

/** Attaches track + instructor to a page of course rows with two extra reads. */
async function hydrateCourses(courses) {
  if (courses.length === 0) return [];

  const trackIds = [...new Set(courses.map((c) => c.trackId).filter(Boolean).map(String))];
  const instructorIds = [
    ...new Set(courses.map((c) => c.instructorId).filter(Boolean).map(String)),
  ];

  const [tracks, instructors] = await Promise.all([
    trackIds.length
      ? Tracks().find({ _id: { $in: trackIds.map((id) => toObjectId(id)) } }).toArray()
      : [],
    instructorIds.length
      ? Instructors().find({ _id: { $in: instructorIds.map((id) => toObjectId(id)) } }).toArray()
      : [],
  ]);

  const trackMap = indexById(tracks);
  const instructorMap = indexById(instructors);

  return courses.map((course) =>
    courseCard(course, {
      track: trackMap.get(String(course.trackId)),
      instructor: instructorMap.get(String(course.instructorId)),
    }),
  );
}

export async function listCourses(params = {}) {
  const filter = await buildCourseFilter(params);
  const projection = { ...COURSE_CARD_PROJECTION };

  let sort;
  if (params.q && (!params.sort || params.sort === 'relevance')) {
    // Relevance ordering needs the text score projected as well as sorted on.
    projection.score = { $meta: 'textScore' };
    sort = { score: { $meta: 'textScore' }, _id: -1 };
  } else {
    sort = resolveSort(COURSE_SORTS, params.sort, params.defaultSort ?? 'recent');
  }

  const { data, meta } = await paginate(Courses(), {
    filter,
    sort,
    projection,
    page: params.page,
    pageSize: params.pageSize,
  });

  return { data: await hydrateCourses(data), meta };
}

export async function listPublishedCourses(params) {
  return listCourses({ ...params, status: 'published' });
}

export async function listFeaturedCourses({ limit = 6 } = {}) {
  const courses = await Courses()
    .find({ status: 'published', featured: true })
    .project(COURSE_CARD_PROJECTION)
    .sort({ publishedAt: -1, _id: -1 })
    .limit(Math.min(24, Math.max(1, limit)))
    .toArray();

  return hydrateCourses(courses);
}

/** Public reads only ever see published courses; staff can preview their drafts. */
export async function findCourseForViewer(slug, user) {
  const course = await Courses().findOne({ slug });
  if (!course) throw ApiError.notFound('Course not found');

  if (course.status !== 'published') {
    const isOwner =
      user &&
      (user.role === 'admin' ||
        (user.instructorProfileId &&
          String(user.instructorProfileId) === String(course.instructorId)));
    if (!isOwner) throw ApiError.notFound('Course not found');
  }

  return course;
}

export async function getCourseDetail(slug, user) {
  const course = await findCourseForViewer(slug, user);

  const [track, instructor, enrollment, favourite] = await Promise.all([
    course.trackId ? Tracks().findOne({ _id: course.trackId }) : null,
    course.instructorId ? Instructors().findOne({ _id: course.instructorId }) : null,
    user ? Enrollments().findOne({ userId: user._id, courseId: course._id }) : null,
    user
      ? Favourites().findOne(
          { userId: user._id, courseId: course._id },
          { projection: { _id: 1 } },
        )
      : null,
  ]);

  return {
    ...courseDetail(course, { track, instructor }),
    enrollment: enrollment ? publicEnrollment(enrollment) : null,
    isFavourite: Boolean(favourite),
    hasAccess: Boolean(enrollment) || !course.premium,
  };
}

export async function getRelatedCourses(slug, { limit = 4 } = {}) {
  const course = await Courses().findOne(
    { slug },
    { projection: { _id: 1, trackId: 1, status: 1 } },
  );
  if (!course) throw ApiError.notFound('Course not found');

  const related = await Courses()
    .find({
      _id: { $ne: course._id },
      status: 'published',
      ...(course.trackId ? { trackId: course.trackId } : {}),
    })
    .project(COURSE_CARD_PROJECTION)
    .sort({ learnersCount: -1, _id: -1 })
    .limit(Math.min(12, Math.max(1, limit)))
    .toArray();

  return hydrateCourses(related);
}

// ---- curriculum & lessons --------------------------------------------------

/**
 * A lesson body is readable when it is a preview, when the caller holds an
 * enrollment, or when the caller manages the course (§5).
 */
export async function resolveAccess(course, user) {
  if (!user) return { enrolled: false, manages: false, enrollment: null };

  const manages =
    user.role === 'admin' ||
    (user.instructorProfileId &&
      String(user.instructorProfileId) === String(course.instructorId));

  const enrollment = await Enrollments().findOne({ userId: user._id, courseId: course._id });

  return { enrolled: Boolean(enrollment), manages: Boolean(manages), enrollment };
}

export async function getCurriculum(slug, user) {
  const course = await findCourseForViewer(slug, user);
  const access = await resolveAccess(course, user);

  const lessons = await Lessons()
    .find({ courseId: course._id })
    .project({ contentHTML: 0 })
    .sort({ sectionOrder: 1, order: 1, _id: 1 })
    .toArray();

  const completed = new Set(
    (access.enrollment?.completedLessonIds ?? []).map((id) => String(id)),
  );

  const sections = new Map();
  for (const lesson of lessons) {
    const key = `${lesson.sectionOrder ?? 0}::${lesson.sectionTitle ?? 'Course content'}`;
    if (!sections.has(key)) {
      sections.set(key, {
        title: lesson.sectionTitle ?? 'Course content',
        order: lesson.sectionOrder ?? 0,
        lessons: [],
        minutes: 0,
      });
    }
    const section = sections.get(key);
    const locked = !(lesson.isPreview || access.enrolled || access.manages);
    section.lessons.push({
      ...lessonSummary(lesson, { locked }),
      completed: completed.has(String(lesson._id)),
    });
    section.minutes += lesson.minutes ?? 0;
  }

  return {
    courseId: String(course._id),
    slug: course.slug,
    title: course.title,
    lessonCount: lessons.length,
    durationMinutes: lessons.reduce((sum, l) => sum + (l.minutes ?? 0), 0),
    hasAccess: access.enrolled || access.manages,
    sections: [...sections.values()].sort((a, b) => a.order - b.order),
  };
}

export async function getLesson(slug, lessonId, user) {
  const course = await findCourseForViewer(slug, user);
  const lesson = await Lessons().findOne({
    _id: toObjectId(lessonId, 'lesson id'),
    courseId: course._id,
  });
  if (!lesson) throw ApiError.notFound('Lesson not found');

  const access = await resolveAccess(course, user);
  if (!lesson.isPreview && !access.enrolled && !access.manages) {
    throw ApiError.forbidden(
      course.premium
        ? 'Purchase this course to unlock this lesson'
        : 'Enrol in this course to unlock this lesson',
      'LESSON_LOCKED',
    );
  }

  // Powers "last opened 2 days ago" on the My Learning cards.
  if (access.enrollment) {
    await Enrollments().updateOne(
      { _id: access.enrollment._id },
      { $set: { lastAccessedAt: new Date() } },
    );
  }

  const [prev, next] = await Promise.all([
    Lessons()
      .find({
        courseId: course._id,
        $or: [
          { sectionOrder: { $lt: lesson.sectionOrder ?? 0 } },
          { sectionOrder: lesson.sectionOrder ?? 0, order: { $lt: lesson.order ?? 0 } },
        ],
      })
      .project({ contentHTML: 0 })
      .sort({ sectionOrder: -1, order: -1 })
      .limit(1)
      .next(),
    Lessons()
      .find({
        courseId: course._id,
        $or: [
          { sectionOrder: { $gt: lesson.sectionOrder ?? 0 } },
          { sectionOrder: lesson.sectionOrder ?? 0, order: { $gt: lesson.order ?? 0 } },
        ],
      })
      .project({ contentHTML: 0 })
      .sort({ sectionOrder: 1, order: 1 })
      .limit(1)
      .next(),
  ]);

  return {
    ...lessonDetail(lesson),
    completed: (access.enrollment?.completedLessonIds ?? []).some(
      (id) => String(id) === String(lesson._id),
    ),
    enrollmentId: access.enrollment ? String(access.enrollment._id) : null,
    prevLesson: prev ? lessonSummary(prev) : null,
    nextLesson: next ? lessonSummary(next) : null,
  };
}

// ---- reviews ---------------------------------------------------------------

const REVIEW_SORTS = {
  recent: { createdAt: -1 },
  oldest: { createdAt: 1 },
  highest: { rating: -1, createdAt: -1 },
  lowest: { rating: 1, createdAt: -1 },
};

export async function getCourseReviews(slug, params = {}) {
  const course = await Courses().findOne({ slug }, { projection: { _id: 1, status: 1 } });
  if (!course) throw ApiError.notFound('Course not found');

  const filter = { courseId: course._id };
  if (params.rating) filter.rating = params.rating;

  const paging = clampPaging(params);

  const [reviews, total, histogramRows] = await Promise.all([
    Reviews()
      .find(filter)
      .sort(resolveSort(REVIEW_SORTS, params.sort, 'recent'))
      .skip(paging.skip)
      .limit(paging.pageSize)
      .toArray(),
    Reviews().countDocuments(filter),
    Reviews()
      .aggregate([
        { $match: { courseId: course._id } },
        { $group: { _id: '$rating', count: { $sum: 1 } } },
      ])
      .toArray(),
  ]);

  const authors = await Users()
    .find(
      { _id: { $in: reviews.map((r) => r.userId) } },
      { projection: { name: 1, avatarUrl: 1 } },
    )
    .toArray();
  const authorMap = indexById(authors);

  const histogram = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  let sum = 0;
  let count = 0;
  for (const row of histogramRows) {
    histogram[row._id] = row.count;
    sum += row._id * row.count;
    count += row.count;
  }

  return {
    data: reviews.map((review) =>
      publicReview(review, { author: authorMap.get(String(review.userId)) }),
    ),
    meta: buildMeta({ page: paging.page, pageSize: paging.pageSize, total }),
    summary: {
      average: count ? Math.round((sum / count) * 10) / 10 : 0,
      count,
      histogram,
    },
  };
}
