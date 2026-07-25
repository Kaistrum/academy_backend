/**
 * Response shapers. Everything the API returns goes through here so that
 * `_id` becomes `id`, secrets (passwordHash, tokenHash, rawEvent) can never
 * leak, and the frontend sees one stable field vocabulary.
 */

const id = (value) => (value ? String(value) : null);

/** Field projections for list reads — heavy Tiptap bodies stay out (§4). */
export const COURSE_CARD_PROJECTION = {
  contentHTML: 0,
  description: 0,
  whatYouLearn: 0,
  requirements: 0,
  faqs: 0,
};

export const LESSON_LIST_PROJECTION = { contentHTML: 0 };

export function publicUser(user) {
  if (!user) return null;
  return {
    id: id(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    avatarUrl: user.avatarUrl ?? null,
    emailVerified: Boolean(user.emailVerifiedAt),
    instructorProfileId: id(user.instructorProfileId),
    createdAt: user.createdAt,
  };
}

export function publicTrack(track) {
  if (!track) return null;
  return {
    id: id(track._id),
    slug: track.slug,
    name: track.name,
    icon: track.icon ?? null,
    blurb: track.blurb ?? '',
    sortOrder: track.sortOrder ?? 0,
    courseCount: track.courseCount ?? 0,
  };
}

export function publicInstructor(instructor) {
  if (!instructor) return null;
  return {
    id: id(instructor._id),
    name: instructor.name,
    title: instructor.title ?? '',
    bio: instructor.bio ?? '',
    avatarUrl: instructor.avatarUrl ?? null,
    ratingAvg: instructor.ratingAvg ?? 0,
    studentsCount: instructor.studentsCount ?? 0,
    coursesCount: instructor.coursesCount ?? 0,
  };
}

/** Admin view keeps the contact address and the linked login. */
export function adminInstructor(instructor) {
  if (!instructor) return null;
  return {
    ...publicInstructor(instructor),
    email: instructor.email ?? null,
    userId: id(instructor.userId),
    createdAt: instructor.createdAt,
    updatedAt: instructor.updatedAt,
  };
}

export function courseCard(course, { track, instructor } = {}) {
  if (!course) return null;
  return {
    id: id(course._id),
    slug: course.slug,
    title: course.title,
    summary: course.summary ?? '',
    format: course.format,
    level: course.level,
    premium: Boolean(course.premium),
    priceKES: course.premium ? (course.priceKES ?? null) : null,
    originalPriceKES: course.premium ? (course.originalPriceKES ?? null) : null,
    featured: Boolean(course.featured),
    status: course.status,
    durationMinutes: course.durationMinutes ?? 0,
    lessonCount: course.lessonCount ?? 0,
    ratingAvg: course.ratingAvg ?? 0,
    ratingCount: course.ratingCount ?? 0,
    learnersCount: course.learnersCount ?? 0,
    publishedAt: course.publishedAt ?? null,
    createdAt: course.createdAt,
    track: track ? publicTrack(track) : undefined,
    instructor: instructor ? publicInstructor(instructor) : undefined,
    trackId: id(course.trackId),
    instructorId: id(course.instructorId),
  };
}

export function courseDetail(course, extras = {}) {
  if (!course) return null;
  return {
    ...courseCard(course, extras),
    description: course.description ?? [],
    contentHTML: course.contentHTML ?? '',
    whatYouLearn: course.whatYouLearn ?? [],
    requirements: course.requirements ?? [],
    faqs: (course.faqs ?? [])
      .slice()
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((f) => ({ question: f.question, answer: f.answer, sortOrder: f.sortOrder ?? 0 })),
    updatedAt: course.updatedAt,
  };
}

export function lessonSummary(lesson, { locked } = {}) {
  if (!lesson) return null;
  return {
    id: id(lesson._id),
    courseId: id(lesson.courseId),
    sectionTitle: lesson.sectionTitle ?? 'Course content',
    sectionOrder: lesson.sectionOrder ?? 0,
    title: lesson.title,
    minutes: lesson.minutes ?? 0,
    isPreview: Boolean(lesson.isPreview),
    order: lesson.order ?? 0,
    ...(locked === undefined ? {} : { locked }),
  };
}

export function lessonDetail(lesson) {
  return {
    ...lessonSummary(lesson, { locked: false }),
    videoUrl: lesson.videoUrl ?? null,
    contentHTML: lesson.contentHTML ?? '',
  };
}

export function publicEnrollment(enrollment) {
  if (!enrollment) return null;
  return {
    id: id(enrollment._id),
    courseId: id(enrollment.courseId),
    status: enrollment.status,
    progressPct: enrollment.progressPct ?? 0,
    completedLessons: enrollment.completedLessons ?? 0,
    completedLessonIds: (enrollment.completedLessonIds ?? []).map(id),
    lastAccessedAt: enrollment.lastAccessedAt ?? null,
    enrolledAt: enrollment.enrolledAt,
    completedAt: enrollment.completedAt ?? null,
  };
}

export function publicReview(review, { author } = {}) {
  if (!review) return null;
  return {
    id: id(review._id),
    courseId: id(review.courseId),
    userId: id(review.userId),
    rating: review.rating,
    body: review.body ?? '',
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    author: author
      ? { id: id(author._id), name: author.name, avatarUrl: author.avatarUrl ?? null }
      : undefined,
  };
}

export function publicCertificate(cert, { course } = {}) {
  if (!cert) return null;
  return {
    id: id(cert._id),
    serial: cert.serial,
    courseId: id(cert.courseId),
    userId: id(cert.userId),
    issuedAt: cert.issuedAt,
    hours: cert.hours ?? 0,
    fileUrl: cert.fileUrl ?? null,
    course: course
      ? { id: id(course._id), slug: course.slug, title: course.title }
      : undefined,
  };
}

/** `rawEvent` is audit-only and never returned. */
export function publicPayment(payment, { course } = {}) {
  if (!payment) return null;
  return {
    id: id(payment._id),
    reference: payment.reference,
    courseId: id(payment.courseId),
    userId: id(payment.userId),
    amountKES: payment.amountKES,
    currency: 'KES',
    provider: payment.provider,
    channel: payment.channel ?? null,
    status: payment.status,
    authorizationUrl: payment.authorizationUrl ?? null,
    paidAt: payment.paidAt ?? null,
    createdAt: payment.createdAt,
    course: course
      ? { id: id(course._id), slug: course.slug, title: course.title }
      : undefined,
  };
}

/** Index an array of documents by `_id` for cheap in-memory joins. */
export function indexById(docs) {
  const map = new Map();
  for (const doc of docs) map.set(String(doc._id), doc);
  return map;
}
