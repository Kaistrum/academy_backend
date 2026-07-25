import { Courses } from '../db/collections.js';
import ApiError from '../lib/apiError.js';
import { idsEqual } from '../lib/ids.js';

/**
 * Ownership scoping for the back office (§5): admins reach every course,
 * instructors only the ones their profile owns. Loads the course once and
 * hands it to the route as `req.course`.
 */
export function loadOwnedCourse({ param = 'slug' } = {}) {
  return async (req, _res, next) => {
    try {
      const slug = req.params[param];
      const course = await Courses().findOne({ slug });
      if (!course) throw ApiError.notFound('Course not found');

      if (req.user.role !== 'admin') {
        if (!req.user.instructorProfileId) {
          throw ApiError.forbidden('Your account is not linked to an instructor profile');
        }
        if (!idsEqual(course.instructorId, req.user.instructorProfileId)) {
          throw ApiError.forbidden('You can only manage your own courses');
        }
      }

      req.course = course;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Filter fragment that limits any admin list to the caller's own courses when
 * they are an instructor. Returns `{}` for admins.
 */
export function ownershipFilter(user, field = 'instructorId') {
  if (user.role === 'admin') return {};
  if (!user.instructorProfileId) {
    throw ApiError.forbidden('Your account is not linked to an instructor profile');
  }
  return { [field]: user.instructorProfileId };
}
