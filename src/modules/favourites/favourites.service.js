import { Courses, Favourites, Instructors, Tracks } from '../../db/collections.js';
import ApiError from '../../lib/apiError.js';
import { paginate } from '../../lib/listQuery.js';
import { COURSE_CARD_PROJECTION, courseCard, indexById } from '../../lib/shape.js';

async function requirePublishedCourse(slug) {
  const course = await Courses().findOne(
    { slug, status: 'published' },
    { projection: { _id: 1, slug: 1 } },
  );
  if (!course) throw ApiError.notFound('Course not found');
  return course;
}

export async function listFavourites(userId, params = {}) {
  const { data: favourites, meta } = await paginate(Favourites(), {
    filter: { userId },
    sort: { createdAt: -1, _id: -1 },
    page: params.page,
    pageSize: params.pageSize,
  });

  if (favourites.length === 0) return { data: [], meta };

  const courses = await Courses()
    .find({ _id: { $in: favourites.map((f) => f.courseId) } })
    .project(COURSE_CARD_PROJECTION)
    .toArray();

  const [tracks, instructors] = await Promise.all([
    Tracks().find({ _id: { $in: courses.map((c) => c.trackId).filter(Boolean) } }).toArray(),
    Instructors()
      .find({ _id: { $in: courses.map((c) => c.instructorId).filter(Boolean) } })
      .toArray(),
  ]);

  const courseMap = indexById(courses);
  const trackMap = indexById(tracks);
  const instructorMap = indexById(instructors);

  // Preserve favourite order, and skip any course that has since been removed.
  const data = favourites
    .map((fav) => {
      const course = courseMap.get(String(fav.courseId));
      if (!course) return null;
      return {
        ...courseCard(course, {
          track: trackMap.get(String(course.trackId)),
          instructor: instructorMap.get(String(course.instructorId)),
        }),
        favouritedAt: fav.createdAt,
      };
    })
    .filter(Boolean);

  return { data, meta };
}

/** Idempotent: saving an already-saved course is a no-op, not a 409. */
export async function addFavourite(userId, slug) {
  const course = await requirePublishedCourse(slug);
  const now = new Date();

  await Favourites().updateOne(
    { userId, courseId: course._id },
    { $setOnInsert: { userId, courseId: course._id, createdAt: now } },
    { upsert: true },
  );

  return { isFavourite: true, courseId: String(course._id), slug: course.slug };
}

export async function removeFavourite(userId, slug) {
  const course = await requirePublishedCourse(slug);
  await Favourites().deleteOne({ userId, courseId: course._id });
  return { isFavourite: false, courseId: String(course._id), slug: course.slug };
}
