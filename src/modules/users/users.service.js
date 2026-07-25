import { Certificates, Enrollments, Lessons, RefreshTokens, Users } from '../../db/collections.js';
import ApiError from '../../lib/apiError.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { publicUser } from '../../lib/shape.js';

export async function updateProfile(userId, patch) {
  const $set = { updatedAt: new Date() };
  if (patch.name !== undefined) $set.name = patch.name.trim();
  if (patch.avatarUrl !== undefined) $set.avatarUrl = patch.avatarUrl || null;

  const user = await Users().findOneAndUpdate(
    { _id: userId },
    { $set },
    { returnDocument: 'after', projection: { passwordHash: 0 } },
  );
  if (!user) throw ApiError.notFound('Account not found');
  return publicUser(user);
}

export async function changePassword(userId, { currentPassword, newPassword }) {
  const user = await Users().findOne({ _id: userId });
  if (!user) throw ApiError.notFound('Account not found');

  if (!user.passwordHash) {
    throw ApiError.badRequest(
      'This account signs in with Google or GitHub. Use "forgot password" to set one.',
    );
  }

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw ApiError.badRequest('Current password is incorrect', {
      currentPassword: 'Current password is incorrect',
    });
  }

  await Users().updateOne(
    { _id: userId },
    { $set: { passwordHash: await hashPassword(newPassword), updatedAt: new Date() } },
  );

  // Every other device is signed out; the caller keeps their current session.
  await RefreshTokens().updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'password_change' } },
  );

  return { changed: true };
}

/**
 * Dashboard tiles (§6.2). `hoursLearned` counts the minutes of lessons the
 * learner has actually ticked off, not the full length of enrolled courses.
 */
export async function getStats(userId) {
  const [enrollmentAgg] = await Enrollments()
    .aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: null,
          enrolled: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          inProgress: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$status', 'active'] }, { $gt: ['$progressPct', 0] }] },
                1,
                0,
              ],
            },
          },
          notStarted: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$status', 'active'] }, { $eq: ['$progressPct', 0] }] },
                1,
                0,
              ],
            },
          },
          lessonsDone: { $sum: '$completedLessons' },
          completedLessonIds: { $push: '$completedLessonIds' },
        },
      },
    ])
    .toArray();

  const lessonIds = (enrollmentAgg?.completedLessonIds ?? []).flat();

  const [minutesAgg] = lessonIds.length
    ? await Lessons()
        .aggregate([
          { $match: { _id: { $in: lessonIds } } },
          { $group: { _id: null, minutes: { $sum: '$minutes' } } },
        ])
        .toArray()
    : [];

  const certificates = await Certificates().countDocuments({ userId });
  const minutes = minutesAgg?.minutes ?? 0;

  return {
    enrolled: enrollmentAgg?.enrolled ?? 0,
    inProgress: enrollmentAgg?.inProgress ?? 0,
    notStarted: enrollmentAgg?.notStarted ?? 0,
    completed: enrollmentAgg?.completed ?? 0,
    certificates,
    lessonsDone: enrollmentAgg?.lessonsDone ?? 0,
    minutesLearned: minutes,
    hoursLearned: Math.round((minutes / 60) * 10) / 10,
  };
}
