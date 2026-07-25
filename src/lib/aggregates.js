import { Courses, Enrollments, Instructors, Lessons, Reviews, Tracks } from '../db/collections.js';

/**
 * Cached counters (§2.6) are denormalised onto the parent document and
 * refreshed on write. Each helper recomputes from the source collection so a
 * missed increment self-heals on the next mutation.
 */

export async function recomputeCourseLessonStats(courseId) {
  const [agg] = await Lessons()
    .aggregate([
      { $match: { courseId } },
      { $group: { _id: null, lessonCount: { $sum: 1 }, durationMinutes: { $sum: '$minutes' } } },
    ])
    .toArray();

  const stats = {
    lessonCount: agg?.lessonCount ?? 0,
    durationMinutes: agg?.durationMinutes ?? 0,
  };

  await Courses().updateOne({ _id: courseId }, { $set: { ...stats, updatedAt: new Date() } });
  return stats;
}

export async function recomputeCourseRating(courseId) {
  const [agg] = await Reviews()
    .aggregate([
      { $match: { courseId } },
      { $group: { _id: null, ratingAvg: { $avg: '$rating' }, ratingCount: { $sum: 1 } } },
    ])
    .toArray();

  const stats = {
    ratingAvg: agg?.ratingAvg ? Math.round(agg.ratingAvg * 10) / 10 : 0,
    ratingCount: agg?.ratingCount ?? 0,
  };

  await Courses().updateOne({ _id: courseId }, { $set: { ...stats, updatedAt: new Date() } });

  const course = await Courses().findOne({ _id: courseId }, { projection: { instructorId: 1 } });
  if (course?.instructorId) await recomputeInstructorStats(course.instructorId);

  return stats;
}

export async function recomputeCourseLearners(courseId) {
  const learnersCount = await Enrollments().countDocuments({ courseId });
  await Courses().updateOne(
    { _id: courseId },
    { $set: { learnersCount, updatedAt: new Date() } },
  );

  const course = await Courses().findOne({ _id: courseId }, { projection: { instructorId: 1 } });
  if (course?.instructorId) await recomputeInstructorStats(course.instructorId);

  return learnersCount;
}

export async function recomputeTrackCourseCount(trackId) {
  if (!trackId) return 0;
  const courseCount = await Courses().countDocuments({ trackId, status: 'published' });
  await Tracks().updateOne({ _id: trackId }, { $set: { courseCount, updatedAt: new Date() } });
  return courseCount;
}

export async function recomputeInstructorStats(instructorId) {
  if (!instructorId) return null;

  const [agg] = await Courses()
    .aggregate([
      { $match: { instructorId } },
      {
        $group: {
          _id: null,
          coursesCount: { $sum: { $cond: [{ $eq: ['$status', 'published'] }, 1, 0] } },
          studentsCount: { $sum: '$learnersCount' },
          ratingSum: { $sum: { $multiply: ['$ratingAvg', '$ratingCount'] } },
          ratingCount: { $sum: '$ratingCount' },
        },
      },
    ])
    .toArray();

  const stats = {
    coursesCount: agg?.coursesCount ?? 0,
    studentsCount: agg?.studentsCount ?? 0,
    ratingAvg: agg?.ratingCount ? Math.round((agg.ratingSum / agg.ratingCount) * 10) / 10 : 0,
  };

  await Instructors().updateOne(
    { _id: instructorId },
    { $set: { ...stats, updatedAt: new Date() } },
  );
  return stats;
}

/** Everything that depends on a single course, in dependency order. */
export async function recomputeCourseAggregates(courseId) {
  await recomputeCourseLessonStats(courseId);
  await recomputeCourseLearners(courseId);
  await recomputeCourseRating(courseId);

  const course = await Courses().findOne(
    { _id: courseId },
    { projection: { trackId: 1, instructorId: 1 } },
  );
  if (course?.trackId) await recomputeTrackCourseCount(course.trackId);
  if (course?.instructorId) await recomputeInstructorStats(course.instructorId);
}
