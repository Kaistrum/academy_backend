import {
  Certificates,
  Courses,
  Enrollments,
  Instructors,
  Lessons,
  Tracks,
} from '../../db/collections.js';
import ApiError from '../../lib/apiError.js';
import { recomputeCourseLearners } from '../../lib/aggregates.js';
import { toObjectId } from '../../lib/ids.js';
import { paginate, resolveSort } from '../../lib/listQuery.js';
import { sendEnrollmentEmail } from '../../lib/mailer.js';
import {
  COURSE_CARD_PROJECTION,
  courseCard,
  indexById,
  lessonSummary,
  publicEnrollment,
} from '../../lib/shape.js';
import { findCourseForViewer } from '../courses/courses.service.js';

const ENROLLMENT_SORTS = {
  recent: { lastAccessedAt: -1 },
  enrolled: { enrolledAt: -1 },
  progress: { progressPct: -1 },
};

/**
 * Idempotent by the `{userId, courseId}` unique index — the free-enrol route,
 * the Paystack verify call and the webhook can all race and only one
 * enrollment survives (§7).
 */
export async function createEnrollment({ userId, courseId, paymentId = null }) {
  const now = new Date();

  const result = await Enrollments().findOneAndUpdate(
    { userId, courseId },
    {
      $setOnInsert: {
        userId,
        courseId,
        status: 'active',
        progressPct: 0,
        completedLessonIds: [],
        completedLessons: 0,
        enrolledAt: now,
        completedAt: null,
        createdAt: now,
      },
      $set: { lastAccessedAt: now, updatedAt: now, ...(paymentId ? { paymentId } : {}) },
    },
    { upsert: true, returnDocument: 'after' },
  );

  await recomputeCourseLearners(courseId);
  return result;
}

/** free → immediate; premium → 402 carrying the checkout hand-off (§6.6). */
export async function enrollInCourse(slug, user) {
  const course = await findCourseForViewer(slug, user);

  const existing = await Enrollments().findOne({ userId: user._id, courseId: course._id });
  if (existing) return { enrollment: publicEnrollment(existing), alreadyEnrolled: true };

  if (course.premium) {
    throw ApiError.paymentRequired('This course requires payment before you can enrol', {
      checkout: {
        slug: course.slug,
        priceKES: course.priceKES,
        currency: 'KES',
        checkoutUrl: `/api/v1/courses/${course.slug}/checkout`,
      },
    });
  }

  const enrollment = await createEnrollment({ userId: user._id, courseId: course._id });

  await sendEnrollmentEmail({
    to: user.email,
    name: user.name,
    courseTitle: course.title,
    slug: course.slug,
  }).catch(() => {});

  return { enrollment: publicEnrollment(enrollment), alreadyEnrolled: false };
}

export async function getEnrollmentForCourse(slug, user) {
  const course = await Courses().findOne({ slug }, { projection: { _id: 1, lessonCount: 1 } });
  if (!course) throw ApiError.notFound('Course not found');

  const enrollment = await Enrollments().findOne({ userId: user._id, courseId: course._id });
  if (!enrollment) throw ApiError.notFound('You are not enrolled in this course');

  const nextLesson = await findNextLesson(course._id, enrollment.completedLessonIds ?? []);

  return {
    ...publicEnrollment(enrollment),
    lessonCount: course.lessonCount ?? 0,
    nextLesson: nextLesson ? lessonSummary(nextLesson) : null,
  };
}

async function findNextLesson(courseId, completedIds) {
  const completed = new Set(completedIds.map(String));
  const lessons = await Lessons()
    .find({ courseId })
    .project({ contentHTML: 0 })
    .sort({ sectionOrder: 1, order: 1, _id: 1 })
    .toArray();

  return lessons.find((l) => !completed.has(String(l._id))) ?? null;
}

/** "My learning": course card + progress + the lesson to resume on. */
export async function listMyEnrollments(userId, params = {}) {
  const filter = { userId };
  if (params.status) filter.status = params.status;

  const { data: enrollments, meta } = await paginate(Enrollments(), {
    filter,
    sort: resolveSort(ENROLLMENT_SORTS, params.sort, 'recent'),
    page: params.page,
    pageSize: params.pageSize,
  });

  if (enrollments.length === 0) return { data: [], meta };

  const courseIds = enrollments.map((e) => e.courseId);
  const courses = await Courses()
    .find({ _id: { $in: courseIds } })
    .project(COURSE_CARD_PROJECTION)
    .toArray();

  const [tracks, instructors, lessons, certificates] = await Promise.all([
    Tracks().find({ _id: { $in: courses.map((c) => c.trackId).filter(Boolean) } }).toArray(),
    Instructors()
      .find({ _id: { $in: courses.map((c) => c.instructorId).filter(Boolean) } })
      .toArray(),
    // One read for every course on the page; "next lesson" is resolved in memory.
    Lessons()
      .find({ courseId: { $in: courseIds } })
      .project({ contentHTML: 0 })
      .sort({ sectionOrder: 1, order: 1, _id: 1 })
      .toArray(),
    Certificates()
      .find({ userId, courseId: { $in: courseIds } }, { projection: { courseId: 1, serial: 1 } })
      .toArray(),
  ]);

  const courseMap = indexById(courses);
  const trackMap = indexById(tracks);
  const instructorMap = indexById(instructors);
  const certificateMap = new Map(certificates.map((c) => [String(c.courseId), c]));

  const lessonsByCourse = new Map();
  for (const lesson of lessons) {
    const key = String(lesson.courseId);
    if (!lessonsByCourse.has(key)) lessonsByCourse.set(key, []);
    lessonsByCourse.get(key).push(lesson);
  }

  const data = enrollments.map((enrollment) => {
    const course = courseMap.get(String(enrollment.courseId));
    const completed = new Set((enrollment.completedLessonIds ?? []).map(String));
    const courseLessons = lessonsByCourse.get(String(enrollment.courseId)) ?? [];
    const next = courseLessons.find((l) => !completed.has(String(l._id))) ?? null;
    const certificate = certificateMap.get(String(enrollment.courseId));

    return {
      ...publicEnrollment(enrollment),
      course: course
        ? courseCard(course, {
            track: trackMap.get(String(course.trackId)),
            instructor: instructorMap.get(String(course.instructorId)),
          })
        : null,
      nextLesson: next ? lessonSummary(next) : null,
      certificateSerial: certificate?.serial ?? null,
    };
  });

  return { data, meta };
}

/**
 * Progress is always recomputed from `completedLessonIds` and the course's own
 * lesson list — a client-sent `progressPct` is never trusted (§5).
 */
export async function markLessonComplete(enrollmentId, lessonId, user, { completed = true } = {}) {
  const enrollment = await Enrollments().findOne({
    _id: toObjectId(enrollmentId, 'enrollment id'),
  });
  if (!enrollment) throw ApiError.notFound('Enrollment not found');
  if (String(enrollment.userId) !== String(user._id)) {
    throw ApiError.forbidden('This enrollment belongs to another account');
  }

  const lesson = await Lessons().findOne(
    { _id: toObjectId(lessonId, 'lesson id'), courseId: enrollment.courseId },
    { projection: { _id: 1 } },
  );
  if (!lesson) throw ApiError.notFound('Lesson not found in this course');

  await Enrollments().updateOne(
    { _id: enrollment._id },
    completed
      ? { $addToSet: { completedLessonIds: lesson._id } }
      : { $pull: { completedLessonIds: lesson._id } },
  );

  return recomputeProgress(enrollment._id);
}

export async function recomputeProgress(enrollmentId) {
  const enrollment = await Enrollments().findOne({ _id: enrollmentId });
  if (!enrollment) throw ApiError.notFound('Enrollment not found');

  const lessonIds = await Lessons()
    .find({ courseId: enrollment.courseId }, { projection: { _id: 1 } })
    .toArray();

  const valid = new Set(lessonIds.map((l) => String(l._id)));
  // Drop ids for lessons that have since been deleted, so progress can't exceed 100.
  const completedIds = (enrollment.completedLessonIds ?? []).filter((id) =>
    valid.has(String(id)),
  );

  const total = lessonIds.length;
  const done = completedIds.length;
  const progressPct = total === 0 ? 0 : Math.round((done / total) * 100);
  const isComplete = total > 0 && done === total;

  const $set = {
    completedLessonIds: completedIds,
    completedLessons: done,
    progressPct,
    status: isComplete ? 'completed' : 'active',
    lastAccessedAt: new Date(),
    updatedAt: new Date(),
  };

  if (isComplete && !enrollment.completedAt) $set.completedAt = new Date();
  if (!isComplete) $set.completedAt = null;

  const updated = await Enrollments().findOneAndUpdate(
    { _id: enrollmentId },
    { $set },
    { returnDocument: 'after' },
  );

  const nextLesson = await findNextLesson(enrollment.courseId, completedIds);

  return {
    ...publicEnrollment(updated),
    lessonCount: total,
    nextLesson: nextLesson ? lessonSummary(nextLesson) : null,
    justCompleted: isComplete && !enrollment.completedAt,
  };
}

/**
 * Adding or removing a lesson moves the denominator for everyone already on
 * the course, so every enrollment's percentage is rebuilt in one pipeline
 * update rather than document by document.
 */
export async function recomputeAllProgressForCourse(courseId) {
  const total = await Lessons().countDocuments({ courseId });
  const now = new Date();

  const completedCount = { $size: { $ifNull: ['$completedLessonIds', []] } };
  const isComplete =
    total === 0
      ? false
      : { $gte: [completedCount, total] };

  await Enrollments().updateMany({ courseId }, [
    {
      $set: {
        completedLessons: completedCount,
        progressPct:
          total === 0
            ? 0
            : {
                $round: [{ $multiply: [{ $divide: [completedCount, total] }, 100] }, 0],
              },
      },
    },
    {
      $set: {
        status: { $cond: [isComplete, 'completed', 'active'] },
        completedAt: { $cond: [isComplete, { $ifNull: ['$completedAt', now] }, null] },
        updatedAt: now,
      },
    },
  ]);

  return { total };
}

export async function unenroll(enrollmentId, user) {
  const enrollment = await Enrollments().findOne({
    _id: toObjectId(enrollmentId, 'enrollment id'),
  });
  if (!enrollment) throw ApiError.notFound('Enrollment not found');
  if (String(enrollment.userId) !== String(user._id)) {
    throw ApiError.forbidden('This enrollment belongs to another account');
  }

  // Paid access is lifetime; dropping it would need a refund, not a delete.
  if (enrollment.paymentId) {
    throw ApiError.conflict(
      'Purchased courses cannot be un-enrolled. Contact support if you need a refund.',
    );
  }

  await Enrollments().deleteOne({ _id: enrollment._id });
  await recomputeCourseLearners(enrollment.courseId);

  return { deleted: true, id: String(enrollment._id) };
}
