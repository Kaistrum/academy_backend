import { Courses, Enrollments, Reviews, Users } from '../../db/collections.js';
import ApiError from '../../lib/apiError.js';
import { recomputeCourseRating } from '../../lib/aggregates.js';
import { toObjectId } from '../../lib/ids.js';
import { paginate, resolveSort } from '../../lib/listQuery.js';
import { indexById, publicReview } from '../../lib/shape.js';

/**
 * Completion gate (§2.10): only a learner who finished the course may review
 * it. Enforced here rather than in the client so it holds for every caller.
 */
async function requireCompletedEnrollment(userId, courseId) {
  const enrollment = await Enrollments().findOne({ userId, courseId });

  if (!enrollment) {
    throw ApiError.forbidden('Enrol in this course before reviewing it', 'NOT_ENROLLED');
  }
  if (enrollment.status !== 'completed') {
    throw ApiError.forbidden(
      'Finish the course before leaving a review',
      'COURSE_NOT_COMPLETED',
    );
  }
  return enrollment;
}

export async function createReview(slug, user, { rating, body }) {
  const course = await Courses().findOne({ slug }, { projection: { _id: 1, status: 1 } });
  if (!course || course.status !== 'published') throw ApiError.notFound('Course not found');

  await requireCompletedEnrollment(user._id, course._id);

  const now = new Date();
  const doc = {
    userId: user._id,
    courseId: course._id,
    rating,
    body: body.trim(),
    createdAt: now,
    updatedAt: now,
  };

  try {
    const result = await Reviews().insertOne(doc);
    doc._id = result.insertedId;
  } catch (err) {
    if (err.code === 11000) {
      throw ApiError.conflict('You have already reviewed this course', 'REVIEW_EXISTS');
    }
    throw err;
  }

  await recomputeCourseRating(course._id);
  return publicReview(doc, { author: user });
}

export async function updateReview(id, user, patch) {
  const reviewId = toObjectId(id, 'review id');
  const review = await Reviews().findOne({ _id: reviewId });
  if (!review) throw ApiError.notFound('Review not found');

  if (String(review.userId) !== String(user._id)) {
    throw ApiError.forbidden('You can only edit your own review');
  }

  const $set = { updatedAt: new Date() };
  if (patch.rating !== undefined) $set.rating = patch.rating;
  if (patch.body !== undefined) $set.body = patch.body.trim();

  const updated = await Reviews().findOneAndUpdate(
    { _id: reviewId },
    { $set },
    { returnDocument: 'after' },
  );

  if (patch.rating !== undefined) await recomputeCourseRating(review.courseId);
  return publicReview(updated, { author: user });
}

/** The author can delete their own; an admin can moderate anyone's (§6.8). */
export async function deleteReview(id, user) {
  const reviewId = toObjectId(id, 'review id');
  const review = await Reviews().findOne({ _id: reviewId });
  if (!review) throw ApiError.notFound('Review not found');

  const isOwner = String(review.userId) === String(user._id);
  if (!isOwner && user.role !== 'admin') {
    throw ApiError.forbidden('You can only delete your own review');
  }

  await Reviews().deleteOne({ _id: reviewId });
  await recomputeCourseRating(review.courseId);

  return { deleted: true, id: String(reviewId), moderated: !isOwner };
}

const MODERATION_SORTS = {
  recent: { createdAt: -1 },
  oldest: { createdAt: 1 },
  lowest: { rating: 1, createdAt: -1 },
  highest: { rating: -1, createdAt: -1 },
};

/**
 * Moderation queue (§6.11). Instructors see only reviews on their own courses;
 * the course scope is resolved to ids first so the review query stays indexed.
 */
export async function listReviewsForModeration(params, user, { courseScope } = {}) {
  const filter = {};

  if (courseScope) {
    const courses = await Courses()
      .find(courseScope, { projection: { _id: 1 } })
      .toArray();
    filter.courseId = { $in: courses.map((c) => c._id) };
  }

  if (params.rating) filter.rating = params.rating;
  if (params.courseId) filter.courseId = toObjectId(params.courseId, 'course id');

  const { data: reviews, meta } = await paginate(Reviews(), {
    filter,
    sort: resolveSort(MODERATION_SORTS, params.sort, 'recent'),
    page: params.page,
    pageSize: params.pageSize,
  });

  const [authors, courses] = await Promise.all([
    Users()
      .find(
        { _id: { $in: reviews.map((r) => r.userId) } },
        { projection: { name: 1, avatarUrl: 1, email: 1 } },
      )
      .toArray(),
    Courses()
      .find(
        { _id: { $in: reviews.map((r) => r.courseId) } },
        { projection: { title: 1, slug: 1 } },
      )
      .toArray(),
  ]);

  const authorMap = indexById(authors);
  const courseMap = indexById(courses);

  const data = reviews.map((review) => {
    const course = courseMap.get(String(review.courseId));
    return {
      ...publicReview(review, { author: authorMap.get(String(review.userId)) }),
      course: course ? { id: String(course._id), slug: course.slug, title: course.title } : null,
    };
  });

  return { data, meta };
}
