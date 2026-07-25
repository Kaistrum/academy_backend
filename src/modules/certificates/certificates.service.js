import { Certificates, Courses, Enrollments, Instructors, Users } from '../../db/collections.js';
import ApiError from '../../lib/apiError.js';
import {
  generateSerial,
  renderCertificatePdf,
  renderCertificateSvg,
} from '../../lib/certificate.js';
import { toObjectId } from '../../lib/ids.js';
import { paginate } from '../../lib/listQuery.js';
import { indexById, publicCertificate } from '../../lib/shape.js';

export async function listMyCertificates(userId, params = {}) {
  const { data: certificates, meta } = await paginate(Certificates(), {
    filter: { userId },
    sort: { issuedAt: -1, _id: -1 },
    page: params.page,
    pageSize: params.pageSize,
  });

  const courses = await Courses()
    .find(
      { _id: { $in: certificates.map((c) => c.courseId) } },
      { projection: { title: 1, slug: 1 } },
    )
    .toArray();
  const courseMap = indexById(courses);

  return {
    data: certificates.map((cert) =>
      publicCertificate(cert, { course: courseMap.get(String(cert.courseId)) }),
    ),
    meta,
  };
}

/** Issued once per {user, course} and only after the course is finished (§6.9). */
export async function issueCertificate(slug, user) {
  const course = await Courses().findOne({ slug });
  if (!course) throw ApiError.notFound('Course not found');

  const existing = await Certificates().findOne({ userId: user._id, courseId: course._id });
  if (existing) {
    return { certificate: publicCertificate(existing, { course }), alreadyIssued: true };
  }

  const enrollment = await Enrollments().findOne({ userId: user._id, courseId: course._id });
  if (!enrollment) throw ApiError.forbidden('You are not enrolled in this course', 'NOT_ENROLLED');
  if (enrollment.status !== 'completed') {
    throw ApiError.forbidden(
      'Complete every lesson to unlock your certificate',
      'COURSE_NOT_COMPLETED',
    );
  }

  const now = new Date();
  const doc = {
    userId: user._id,
    courseId: course._id,
    serial: generateSerial(now),
    issuedAt: now,
    hours: Math.round(((course.durationMinutes ?? 0) / 60) * 10) / 10,
    fileUrl: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const result = await Certificates().insertOne(doc);
    doc._id = result.insertedId;
  } catch (err) {
    // Two tabs clicking "get certificate" at once — return the one that landed.
    if (err.code === 11000) {
      const found = await Certificates().findOne({ userId: user._id, courseId: course._id });
      return { certificate: publicCertificate(found, { course }), alreadyIssued: true };
    }
    throw err;
  }

  return { certificate: publicCertificate(doc, { course }), alreadyIssued: false };
}

async function loadCertificate(id, user) {
  const cert = await Certificates().findOne({ _id: toObjectId(id, 'certificate id') });
  if (!cert) throw ApiError.notFound('Certificate not found');

  if (String(cert.userId) !== String(user._id) && user.role !== 'admin') {
    throw ApiError.forbidden('This certificate belongs to another learner');
  }
  return cert;
}

export async function getCertificate(id, user) {
  const cert = await loadCertificate(id, user);
  const course = await Courses().findOne(
    { _id: cert.courseId },
    { projection: { title: 1, slug: 1 } },
  );
  return publicCertificate(cert, { course });
}

/** Rendered on demand rather than stored — the source data is all in Mongo. */
export async function renderCertificate(id, user, format) {
  const cert = await loadCertificate(id, user);

  const [course, learner] = await Promise.all([
    Courses().findOne({ _id: cert.courseId }),
    Users().findOne({ _id: cert.userId }, { projection: { name: 1 } }),
  ]);

  const instructor = course?.instructorId
    ? await Instructors().findOne({ _id: course.instructorId }, { projection: { name: 1 } })
    : null;

  const payload = {
    learnerName: learner?.name ?? 'Learner',
    courseTitle: course?.title ?? 'Kaistrum Academy course',
    instructorName: instructor?.name ?? null,
    hours: cert.hours ?? 0,
    serial: cert.serial,
    issuedAt: cert.issuedAt,
  };

  const filename = `kaistrum-certificate-${cert.serial}.${format}`;

  if (format === 'pdf') {
    return {
      contentType: 'application/pdf',
      filename,
      body: await renderCertificatePdf(payload),
    };
  }

  return {
    contentType: 'image/svg+xml; charset=utf-8',
    filename,
    body: renderCertificateSvg(payload),
  };
}

/** Public verification — deliberately minimal, no ids and no email address. */
export async function verifyCertificate(serial) {
  const cert = await Certificates().findOne({ serial: serial.toUpperCase() });
  if (!cert) throw ApiError.notFound('No certificate matches that serial number');

  const [course, learner] = await Promise.all([
    Courses().findOne({ _id: cert.courseId }, { projection: { title: 1, slug: 1 } }),
    Users().findOne({ _id: cert.userId }, { projection: { name: 1 } }),
  ]);

  return {
    valid: true,
    serial: cert.serial,
    learnerName: learner?.name ?? 'Unknown learner',
    courseTitle: course?.title ?? 'Unknown course',
    courseSlug: course?.slug ?? null,
    hours: cert.hours ?? 0,
    issuedAt: cert.issuedAt,
  };
}
