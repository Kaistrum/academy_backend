import { Courses, Instructors, Users } from '../../db/collections.js';
import ApiError from '../../lib/apiError.js';
import { recomputeInstructorStats } from '../../lib/aggregates.js';
import { toObjectId } from '../../lib/ids.js';
import { paginate, resolveSort } from '../../lib/listQuery.js';
import { adminInstructor, publicInstructor } from '../../lib/shape.js';
import { anchoredRegex } from '../../lib/slug.js';
import { CI_COLLATION } from '../../db/indexes.js';
import { listCourses } from '../courses/courses.service.js';

const INSTRUCTOR_SORTS = {
  az: { name: 1 },
  za: { name: -1 },
  rating: { ratingAvg: -1 },
  students: { studentsCount: -1 },
  courses: { coursesCount: -1 },
  recent: { createdAt: -1 },
};

export async function getInstructor(id) {
  const instructor = await Instructors().findOne({ _id: toObjectId(id, 'instructor id') });
  if (!instructor) throw ApiError.notFound('Instructor not found');
  return publicInstructor(instructor);
}

export async function getInstructorCourses(id, params) {
  const instructorId = toObjectId(id, 'instructor id');
  const exists = await Instructors().countDocuments({ _id: instructorId }, { limit: 1 });
  if (!exists) throw ApiError.notFound('Instructor not found');

  return listCourses({ ...params, instructorId, status: 'published' });
}

/** Admins see every tutor; an instructor only ever sees their own profile (§6.4). */
export async function listInstructors(params, user) {
  const filter = {};

  if (user.role !== 'admin') {
    if (!user.instructorProfileId) {
      throw ApiError.forbidden('Your account is not linked to an instructor profile');
    }
    filter._id = user.instructorProfileId;
  }

  // Anchored regex + strength-2 collation stays index-friendly (§4).
  if (params.q) filter.name = anchoredRegex(params.q);

  const { data, meta } = await paginate(Instructors(), {
    filter,
    sort: resolveSort(INSTRUCTOR_SORTS, params.sort, 'az'),
    page: params.page,
    pageSize: params.pageSize,
    collation: CI_COLLATION,
  });

  return { data: data.map(adminInstructor), meta };
}

/**
 * Optionally links a login. Linking promotes that user to `instructor` and
 * points `instructorProfileId` at this profile, which is what the ownership
 * checks in the back office read.
 */
async function linkUser(userId, instructorId) {
  if (!userId) return null;

  const user = await Users().findOne({ _id: userId });
  if (!user) throw ApiError.badRequest('The user to link does not exist');

  if (user.instructorProfileId && String(user.instructorProfileId) !== String(instructorId)) {
    throw ApiError.conflict('That user is already linked to another instructor profile');
  }

  await Users().updateOne(
    { _id: userId },
    {
      $set: {
        instructorProfileId: instructorId,
        role: user.role === 'admin' ? 'admin' : 'instructor',
        updatedAt: new Date(),
      },
    },
  );

  return user;
}

export async function createInstructor(payload) {
  const now = new Date();
  const userId = payload.userId ? toObjectId(payload.userId, 'user id') : null;

  const doc = {
    userId,
    name: payload.name.trim(),
    title: payload.title ?? '',
    bio: payload.bio ?? '',
    email: payload.email?.toLowerCase() ?? null,
    avatarUrl: payload.avatarUrl || null,
    ratingAvg: 0,
    studentsCount: 0,
    coursesCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  const result = await Instructors().insertOne(doc);
  await linkUser(userId, result.insertedId);

  return adminInstructor({ ...doc, _id: result.insertedId });
}

export async function updateInstructor(id, patch) {
  const instructorId = toObjectId(id, 'instructor id');
  const instructor = await Instructors().findOne({ _id: instructorId });
  if (!instructor) throw ApiError.notFound('Instructor not found');

  const $set = { updatedAt: new Date() };
  for (const key of ['name', 'title', 'bio']) {
    if (patch[key] !== undefined) $set[key] = patch[key];
  }
  if (patch.email !== undefined) $set.email = patch.email?.toLowerCase() ?? null;
  if (patch.avatarUrl !== undefined) $set.avatarUrl = patch.avatarUrl || null;

  if (patch.userId !== undefined) {
    const nextUserId = patch.userId ? toObjectId(patch.userId, 'user id') : null;

    if (instructor.userId && String(instructor.userId) !== String(nextUserId)) {
      await Users().updateOne(
        { _id: instructor.userId },
        { $set: { instructorProfileId: null, updatedAt: new Date() } },
      );
    }
    await linkUser(nextUserId, instructorId);
    $set.userId = nextUserId;
  }

  const updated = await Instructors().findOneAndUpdate(
    { _id: instructorId },
    { $set },
    { returnDocument: 'after' },
  );
  return adminInstructor(updated);
}

export async function deleteInstructor(id) {
  const instructorId = toObjectId(id, 'instructor id');
  const instructor = await Instructors().findOne({ _id: instructorId });
  if (!instructor) throw ApiError.notFound('Instructor not found');

  const courseCount = await Courses().countDocuments({ instructorId });
  if (courseCount > 0) {
    throw ApiError.conflict(
      `This tutor still owns ${courseCount} course${courseCount === 1 ? '' : 's'}. Reassign them first.`,
    );
  }

  if (instructor.userId) {
    await Users().updateOne(
      { _id: instructor.userId },
      { $set: { instructorProfileId: null, role: 'learner', updatedAt: new Date() } },
    );
  }

  await Instructors().deleteOne({ _id: instructorId });
  return { deleted: true, id: String(instructorId) };
}

export async function refreshInstructorStats(id) {
  return recomputeInstructorStats(toObjectId(id, 'instructor id'));
}
