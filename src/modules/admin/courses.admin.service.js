import {
  Courses,
  Enrollments,
  Favourites,
  Instructors,
  Lessons,
  Tracks,
} from '../../db/collections.js';
import ApiError from '../../lib/apiError.js';
import {
  recomputeCourseAggregates,
  recomputeCourseLessonStats,
  recomputeTrackCourseCount,
} from '../../lib/aggregates.js';
import { toObjectId } from '../../lib/ids.js';
import { courseDetail, lessonDetail, lessonSummary } from '../../lib/shape.js';
import { uniqueSlug } from '../../lib/slug.js';
import { ownershipFilter } from '../../middleware/ownCourse.js';
import { listCourses } from '../courses/courses.service.js';
import { recomputeAllProgressForCourse } from '../enrollments/enrollments.service.js';

/** Back-office catalogue: drafts included, instructors scoped to their own. */
export async function listAdminCourses(params, user) {
  const scope = ownershipFilter(user);
  return listCourses({
    ...params,
    instructorId: scope.instructorId,
    status: params.status,
    defaultSort: 'newest',
  });
}

async function resolveInstructorId(payload, user) {
  if (user.role !== 'admin') {
    if (!user.instructorProfileId) {
      throw ApiError.forbidden('Your account is not linked to an instructor profile');
    }
    // An instructor cannot assign a course to someone else.
    return user.instructorProfileId;
  }

  if (!payload.instructorId) {
    throw ApiError.badRequest('Choose an instructor for this course', {
      instructorId: 'Required',
    });
  }

  const instructorId = toObjectId(payload.instructorId, 'instructor id');
  const exists = await Instructors().countDocuments({ _id: instructorId }, { limit: 1 });
  if (!exists) throw ApiError.badRequest('That instructor does not exist');
  return instructorId;
}

async function resolveTrackId(trackIdOrSlug) {
  if (!trackIdOrSlug) return null;

  const track = /^[a-f\d]{24}$/i.test(trackIdOrSlug)
    ? await Tracks().findOne({ _id: toObjectId(trackIdOrSlug, 'track id') })
    : await Tracks().findOne({ slug: trackIdOrSlug });

  if (!track) throw ApiError.badRequest('That track does not exist');
  return track._id;
}

function normalisePricing(payload, current = {}) {
  const premium = payload.premium ?? current.premium ?? false;

  if (!premium) return { premium: false, priceKES: null, originalPriceKES: null };

  const priceKES = payload.priceKES ?? current.priceKES ?? null;
  if (!priceKES || priceKES <= 0) {
    throw ApiError.badRequest('A premium course needs a price in KES', {
      priceKES: 'Required for premium courses',
    });
  }

  const originalPriceKES = payload.originalPriceKES ?? current.originalPriceKES ?? null;
  if (originalPriceKES !== null && originalPriceKES < priceKES) {
    throw ApiError.badRequest('The original price must be higher than the current price', {
      originalPriceKES: 'Must be greater than the price',
    });
  }

  return { premium: true, priceKES, originalPriceKES };
}

export async function createCourse(payload, user) {
  const now = new Date();
  const instructorId = await resolveInstructorId(payload, user);
  const trackId = await resolveTrackId(payload.trackId);
  const status = payload.status ?? 'draft';

  const doc = {
    slug: await uniqueSlug(Courses(), payload.slug || payload.title),
    title: payload.title.trim(),
    summary: payload.summary ?? '',
    description: payload.description ?? [],
    contentHTML: payload.contentHTML ?? '',
    trackId,
    instructorId,
    format: payload.format,
    level: payload.level,
    ...normalisePricing(payload),
    featured: payload.featured ?? false,
    status,
    whatYouLearn: payload.whatYouLearn ?? [],
    requirements: payload.requirements ?? [],
    faqs: (payload.faqs ?? []).map((f, i) => ({ ...f, sortOrder: f.sortOrder ?? i })),
    durationMinutes: 0,
    lessonCount: 0,
    ratingAvg: 0,
    ratingCount: 0,
    learnersCount: 0,
    publishedAt: status === 'published' ? now : null,
    createdAt: now,
    updatedAt: now,
  };

  const result = await Courses().insertOne(doc);
  const created = { ...doc, _id: result.insertedId };

  await recomputeCourseAggregates(created._id);
  return getAdminCourse(created.slug);
}

export async function updateCourse(course, patch, user) {
  const $set = { updatedAt: new Date() };

  for (const key of [
    'title',
    'summary',
    'description',
    'contentHTML',
    'format',
    'level',
    'whatYouLearn',
    'requirements',
  ]) {
    if (patch[key] !== undefined) $set[key] = patch[key];
  }

  if (patch.faqs !== undefined) {
    $set.faqs = patch.faqs.map((f, i) => ({ ...f, sortOrder: f.sortOrder ?? i }));
  }

  // Featuring a course is an editorial decision, so it stays admin-only.
  if (patch.featured !== undefined) {
    if (user.role !== 'admin') throw ApiError.forbidden('Only an admin can feature a course');
    $set.featured = patch.featured;
  }

  if (patch.slug !== undefined && patch.slug !== course.slug) {
    $set.slug = await uniqueSlug(Courses(), patch.slug, course._id);
  }

  if (patch.instructorId !== undefined) {
    if (user.role !== 'admin') throw ApiError.forbidden('Only an admin can reassign a course');
    $set.instructorId = await resolveInstructorId(patch, user);
  }

  const previousTrackId = course.trackId;
  if (patch.trackId !== undefined) $set.trackId = await resolveTrackId(patch.trackId);

  if (patch.premium !== undefined || patch.priceKES !== undefined || patch.originalPriceKES !== undefined) {
    Object.assign($set, normalisePricing(patch, course));
  }

  if (patch.status !== undefined && patch.status !== course.status) {
    $set.status = patch.status;
    // First publish stamps publishedAt; re-publishing keeps the original date.
    if (patch.status === 'published' && !course.publishedAt) $set.publishedAt = new Date();
  }

  const updated = await Courses().findOneAndUpdate(
    { _id: course._id },
    { $set },
    { returnDocument: 'after' },
  );

  await recomputeCourseAggregates(updated._id);
  if (previousTrackId && String(previousTrackId) !== String(updated.trackId)) {
    await recomputeTrackCourseCount(previousTrackId);
  }

  return getAdminCourse(updated.slug);
}

export async function deleteCourse(course) {
  const enrolled = await Enrollments().countDocuments({ courseId: course._id });
  if (enrolled > 0) {
    throw ApiError.conflict(
      `${enrolled} learner${enrolled === 1 ? ' is' : 's are'} enrolled in this course. Unpublish it instead of deleting it.`,
    );
  }

  await Lessons().deleteMany({ courseId: course._id });
  // Saved-course entries would otherwise dangle in every learner's list.
  await Favourites().deleteMany({ courseId: course._id });
  await Courses().deleteOne({ _id: course._id });
  if (course.trackId) await recomputeTrackCourseCount(course.trackId);

  return { deleted: true, id: String(course._id), slug: course.slug };
}

export async function getAdminCourse(slug) {
  const course = await Courses().findOne({ slug });
  if (!course) throw ApiError.notFound('Course not found');

  const [track, instructor] = await Promise.all([
    course.trackId ? Tracks().findOne({ _id: course.trackId }) : null,
    course.instructorId ? Instructors().findOne({ _id: course.instructorId }) : null,
  ]);

  return courseDetail(course, { track, instructor });
}

// ---- lessons ---------------------------------------------------------------

export async function listCourseLessons(course) {
  const lessons = await Lessons()
    .find({ courseId: course._id })
    .sort({ sectionOrder: 1, order: 1, _id: 1 })
    .toArray();

  return lessons.map((lesson) => ({
    ...lessonSummary(lesson),
    videoUrl: lesson.videoUrl ?? null,
  }));
}

export async function getLessonForEdit(course, lessonId) {
  const lesson = await Lessons().findOne({
    _id: toObjectId(lessonId, 'lesson id'),
    courseId: course._id,
  });
  if (!lesson) throw ApiError.notFound('Lesson not found');
  return lessonDetail(lesson);
}

export async function createLesson(course, payload) {
  const now = new Date();
  const sectionOrder = payload.sectionOrder ?? 0;

  // Append to the end of its section unless an explicit position is given.
  const last = await Lessons()
    .find({ courseId: course._id, sectionOrder })
    .sort({ order: -1 })
    .limit(1)
    .next();

  const doc = {
    courseId: course._id,
    sectionTitle: payload.sectionTitle ?? 'Course content',
    sectionOrder,
    title: payload.title.trim(),
    minutes: payload.minutes ?? 0,
    isPreview: payload.isPreview ?? false,
    videoUrl: payload.videoUrl || null,
    contentHTML: payload.contentHTML ?? '',
    order: payload.order ?? (last ? (last.order ?? 0) + 1 : 0),
    createdAt: now,
    updatedAt: now,
  };

  const result = await Lessons().insertOne(doc);

  await recomputeCourseLessonStats(course._id);
  await recomputeAllProgressForCourse(course._id);

  return lessonDetail({ ...doc, _id: result.insertedId });
}

export async function updateLesson(course, lessonId, patch) {
  const _id = toObjectId(lessonId, 'lesson id');
  const lesson = await Lessons().findOne({ _id, courseId: course._id });
  if (!lesson) throw ApiError.notFound('Lesson not found');

  const $set = { updatedAt: new Date() };
  for (const key of [
    'sectionTitle',
    'sectionOrder',
    'title',
    'minutes',
    'isPreview',
    'contentHTML',
    'order',
  ]) {
    if (patch[key] !== undefined) $set[key] = patch[key];
  }
  if (patch.videoUrl !== undefined) $set.videoUrl = patch.videoUrl || null;

  const updated = await Lessons().findOneAndUpdate(
    { _id },
    { $set },
    { returnDocument: 'after' },
  );

  if (patch.minutes !== undefined) await recomputeCourseLessonStats(course._id);
  return lessonDetail(updated);
}

export async function deleteLesson(course, lessonId) {
  const _id = toObjectId(lessonId, 'lesson id');
  const lesson = await Lessons().findOne({ _id, courseId: course._id });
  if (!lesson) throw ApiError.notFound('Lesson not found');

  await Lessons().deleteOne({ _id });

  // Drop the id from progress before recomputing, or percentages overshoot.
  await Enrollments().updateMany(
    { courseId: course._id },
    { $pull: { completedLessonIds: _id } },
  );

  await recomputeCourseLessonStats(course._id);
  await recomputeAllProgressForCourse(course._id);

  return { deleted: true, id: String(_id) };
}

/** Drag-and-drop reorder: one bulk write for the whole curriculum. */
export async function reorderLessons(course, items) {
  const ids = items.map((item) => toObjectId(item.id, 'lesson id'));

  const owned = await Lessons()
    .find({ _id: { $in: ids }, courseId: course._id }, { projection: { _id: 1 } })
    .toArray();

  if (owned.length !== ids.length) {
    throw ApiError.badRequest('One or more lessons do not belong to this course');
  }

  const now = new Date();
  await Lessons().bulkWrite(
    items.map((item, index) => ({
      updateOne: {
        filter: { _id: toObjectId(item.id, 'lesson id'), courseId: course._id },
        update: {
          $set: {
            order: item.order ?? index,
            ...(item.sectionTitle !== undefined ? { sectionTitle: item.sectionTitle } : {}),
            ...(item.sectionOrder !== undefined ? { sectionOrder: item.sectionOrder } : {}),
            updatedAt: now,
          },
        },
      },
    })),
    { ordered: false },
  );

  return listCourseLessons(course);
}
