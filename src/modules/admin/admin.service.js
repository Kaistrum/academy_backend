import {
  Certificates,
  Courses,
  Enrollments,
  Instructors,
  Payments,
  Reviews,
  Users,
} from '../../db/collections.js';
import { CI_COLLATION } from '../../db/indexes.js';
import ApiError from '../../lib/apiError.js';
import { toObjectId } from '../../lib/ids.js';
import { clampPaging, dateRange, paginate, resolveSort } from '../../lib/listQuery.js';
import { indexById, publicUser } from '../../lib/shape.js';
import { anchoredRegex } from '../../lib/slug.js';
import { buildMeta } from '../../utils/response.js';
import { ownershipFilter } from '../../middleware/ownCourse.js';

const MONTH_KEY = { $dateToString: { format: '%Y-%m', date: '$paidAt' } };

/** Course ids the caller is allowed to see — everything, for an admin. */
async function scopedCourseIds(user) {
  const scope = ownershipFilter(user);
  if (!scope.instructorId) return null;

  const owned = await Courses()
    .find({ instructorId: scope.instructorId }, { projection: { _id: 1 } })
    .toArray();
  return owned.map((c) => c._id);
}

/**
 * Dashboard KPIs (§6.11). An instructor gets the same shape computed over just
 * their own courses, so the admin screen works unchanged for both roles.
 */
export async function getOverview(user) {
  const courseIds = await scopedCourseIds(user);
  const courseFilter = courseIds ? { _id: { $in: courseIds } } : {};
  const byCourse = courseIds ? { courseId: { $in: courseIds } } : {};

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const twelveMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));

  const paidMatch = { status: 'paid', ...byCourse };

  const [
    revenueAgg,
    thisMonthAgg,
    lastMonthAgg,
    revenueByMonthRows,
    publishedCourses,
    draftCourses,
    tutors,
    enrollmentsTotal,
    completionsTotal,
    reviewsTotal,
    certificatesTotal,
    topCourseRows,
    topTutorRows,
    recentPayments,
  ] = await Promise.all([
    Payments().aggregate([{ $match: paidMatch }, { $group: { _id: null, total: { $sum: '$amountKES' }, count: { $sum: 1 } } }]).toArray(),
    Payments().aggregate([{ $match: { ...paidMatch, paidAt: { $gte: monthStart } } }, { $group: { _id: null, total: { $sum: '$amountKES' } } }]).toArray(),
    Payments().aggregate([{ $match: { ...paidMatch, paidAt: { $gte: prevMonthStart, $lt: monthStart } } }, { $group: { _id: null, total: { $sum: '$amountKES' } } }]).toArray(),
    Payments()
      .aggregate([
        { $match: { ...paidMatch, paidAt: { $gte: twelveMonthsAgo } } },
        { $group: { _id: MONTH_KEY, revenueKES: { $sum: '$amountKES' }, orders: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ])
      .toArray(),
    Courses().countDocuments({ ...courseFilter, status: 'published' }),
    Courses().countDocuments({ ...courseFilter, status: 'draft' }),
    courseIds ? 1 : Instructors().countDocuments({}),
    Enrollments().countDocuments(byCourse),
    Enrollments().countDocuments({ ...byCourse, status: 'completed' }),
    Reviews().countDocuments(byCourse),
    Certificates().countDocuments(byCourse),
    Payments()
      .aggregate([
        { $match: paidMatch },
        { $group: { _id: '$courseId', revenueKES: { $sum: '$amountKES' }, orders: { $sum: 1 } } },
        { $sort: { revenueKES: -1 } },
        { $limit: 5 },
      ])
      .toArray(),
    Courses()
      .aggregate([
        { $match: courseFilter },
        {
          $group: {
            _id: '$instructorId',
            learners: { $sum: '$learnersCount' },
            courses: { $sum: 1 },
            ratingSum: { $sum: { $multiply: ['$ratingAvg', '$ratingCount'] } },
            ratingCount: { $sum: '$ratingCount' },
          },
        },
        { $sort: { learners: -1 } },
        { $limit: 5 },
      ])
      .toArray(),
    Payments()
      .find({ ...byCourse, status: 'paid' }, { projection: { rawEvent: 0 } })
      .sort({ paidAt: -1 })
      .limit(5)
      .toArray(),
  ]);

  const totalRevenue = revenueAgg[0]?.total ?? 0;
  const thisMonth = thisMonthAgg[0]?.total ?? 0;
  const lastMonth = lastMonthAgg[0]?.total ?? 0;

  const growthMoM =
    lastMonth === 0
      ? thisMonth > 0
        ? 100
        : 0
      : Math.round(((thisMonth - lastMonth) / lastMonth) * 1000) / 10;

  // Fill gaps so the chart always has 12 contiguous buckets.
  const monthMap = new Map(revenueByMonthRows.map((r) => [r._id, r]));
  const revenueByMonth = [];
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    revenueByMonth.push({
      month: key,
      label: d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
      revenueKES: monthMap.get(key)?.revenueKES ?? 0,
      orders: monthMap.get(key)?.orders ?? 0,
    });
  }

  const [topCourseDocs, topTutorDocs, recentCourses] = await Promise.all([
    Courses()
      .find(
        { _id: { $in: topCourseRows.map((r) => r._id).filter(Boolean) } },
        { projection: { title: 1, slug: 1, learnersCount: 1, ratingAvg: 1 } },
      )
      .toArray(),
    Instructors()
      .find(
        { _id: { $in: topTutorRows.map((r) => r._id).filter(Boolean) } },
        { projection: { name: 1, title: 1, avatarUrl: 1 } },
      )
      .toArray(),
    Courses()
      .find(
        { _id: { $in: recentPayments.map((p) => p.courseId).filter(Boolean) } },
        { projection: { title: 1, slug: 1 } },
      )
      .toArray(),
  ]);

  const courseMap = indexById(topCourseDocs);
  const tutorMap = indexById(topTutorDocs);
  const recentCourseMap = indexById(recentCourses);

  return {
    totalRevenueKES: totalRevenue,
    revenueThisMonthKES: thisMonth,
    revenueLastMonthKES: lastMonth,
    growthMoM,
    paidOrders: revenueAgg[0]?.count ?? 0,
    publishedCourses,
    draftCourses,
    tutors,
    enrollments: enrollmentsTotal,
    completions: completionsTotal,
    reviews: reviewsTotal,
    certificates: certificatesTotal,
    revenueByMonth,
    topCourses: topCourseRows.map((row) => {
      const course = courseMap.get(String(row._id));
      return {
        id: String(row._id),
        slug: course?.slug ?? null,
        title: course?.title ?? 'Removed course',
        revenueKES: row.revenueKES,
        orders: row.orders,
        learnersCount: course?.learnersCount ?? 0,
        ratingAvg: course?.ratingAvg ?? 0,
      };
    }),
    topTutors: topTutorRows.map((row) => {
      const tutor = tutorMap.get(String(row._id));
      return {
        id: String(row._id),
        name: tutor?.name ?? 'Unassigned',
        title: tutor?.title ?? '',
        avatarUrl: tutor?.avatarUrl ?? null,
        courses: row.courses,
        learners: row.learners,
        ratingAvg: row.ratingCount ? Math.round((row.ratingSum / row.ratingCount) * 10) / 10 : 0,
      };
    }),
    recentOrders: recentPayments.map((p) => ({
      id: String(p._id),
      reference: p.reference,
      amountKES: p.amountKES,
      channel: p.channel ?? null,
      paidAt: p.paidAt,
      course: recentCourseMap.get(String(p.courseId))?.title ?? null,
    })),
  };
}

// ---- learners --------------------------------------------------------------

const ROSTER_SORTS = {
  recent: { enrolledAt: -1 },
  progress: { progressPct: -1 },
  oldest: { enrolledAt: 1 },
};

/** Per-course roster (§6.11) — progress, status and enrolment date. */
export async function getCourseRoster(course, params) {
  const filter = { courseId: course._id };
  if (params.status) filter.status = params.status;

  // Name/email search resolves to user ids first so the enrollment read stays indexed.
  if (params.q) {
    const rx = anchoredRegex(params.q);
    const matches = await Users()
      .find({ $or: [{ name: rx }, { email: rx }] }, { projection: { _id: 1 } })
      .limit(500)
      .toArray();
    filter.userId = { $in: matches.map((u) => u._id) };
  }

  const { data: enrollments, meta } = await paginate(Enrollments(), {
    filter,
    sort: resolveSort(ROSTER_SORTS, params.sort, 'recent'),
    page: params.page,
    pageSize: params.pageSize,
  });

  const learners = await Users()
    .find(
      { _id: { $in: enrollments.map((e) => e.userId) } },
      { projection: { name: 1, email: 1, avatarUrl: 1 } },
    )
    .toArray();
  const learnerMap = indexById(learners);

  const data = enrollments.map((enrollment) => {
    const learner = learnerMap.get(String(enrollment.userId));
    return {
      enrollmentId: String(enrollment._id),
      userId: String(enrollment.userId),
      name: learner?.name ?? 'Deleted account',
      email: learner?.email ?? null,
      avatarUrl: learner?.avatarUrl ?? null,
      status: enrollment.status,
      progressPct: enrollment.progressPct ?? 0,
      completedLessons: enrollment.completedLessons ?? 0,
      enrolledAt: enrollment.enrolledAt,
      lastAccessedAt: enrollment.lastAccessedAt ?? null,
      completedAt: enrollment.completedAt ?? null,
    };
  });

  return { data, meta };
}

const LEARNER_SORTS = {
  recent: { createdAt: -1 },
  az: { name: 1 },
  za: { name: -1 },
};

/**
 * Distinct people view. Enrollment counts are folded in with one aggregate
 * over the page's user ids rather than a query per row.
 */
export async function listLearners(params) {
  const filter = {};
  if (params.role) filter.role = params.role;

  if (params.q) {
    const rx = anchoredRegex(params.q);
    filter.$or = [{ name: rx }, { email: rx }];
  }

  const range = dateRange(params.dateFrom, params.dateTo);
  if (range) filter.createdAt = range;

  const paging = clampPaging(params);

  const [users, total] = await Promise.all([
    Users()
      .find(filter, { projection: { passwordHash: 0 } })
      .collation(CI_COLLATION)
      .sort(resolveSort(LEARNER_SORTS, params.sort, 'recent'))
      .skip(paging.skip)
      .limit(paging.pageSize)
      .toArray(),
    Users().countDocuments(filter, { collation: CI_COLLATION }),
  ]);

  const userIds = users.map((u) => u._id);

  const [enrollmentRows, certificateRows] = await Promise.all([
    Enrollments()
      .aggregate([
        { $match: { userId: { $in: userIds } } },
        {
          $group: {
            _id: '$userId',
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
            lastAccessedAt: { $max: '$lastAccessedAt' },
          },
        },
      ])
      .toArray(),
    Certificates()
      .aggregate([
        { $match: { userId: { $in: userIds } } },
        { $group: { _id: '$userId', count: { $sum: 1 } } },
      ])
      .toArray(),
  ]);

  const statsMap = new Map(enrollmentRows.map((r) => [String(r._id), r]));
  const certMap = new Map(certificateRows.map((r) => [String(r._id), r.count]));

  const data = users.map((user) => {
    const stats = statsMap.get(String(user._id));
    return {
      ...publicUser(user),
      enrolled: stats?.enrolled ?? 0,
      inProgress: stats?.inProgress ?? 0,
      completed: stats?.completed ?? 0,
      certificates: certMap.get(String(user._id)) ?? 0,
      lastAccessedAt: stats?.lastAccessedAt ?? null,
    };
  });

  return {
    data,
    meta: buildMeta({ page: paging.page, pageSize: paging.pageSize, total }),
  };
}

/** One person across every course they touch (§6.11). */
export async function getLearnerDetail(userId) {
  const _id = toObjectId(userId, 'user id');
  const user = await Users().findOne({ _id }, { projection: { passwordHash: 0 } });
  if (!user) throw ApiError.notFound('Learner not found');

  const enrollments = await Enrollments().find({ userId: _id }).sort({ enrolledAt: -1 }).toArray();

  const [courses, certificates, payments] = await Promise.all([
    Courses()
      .find(
        { _id: { $in: enrollments.map((e) => e.courseId) } },
        { projection: { title: 1, slug: 1, lessonCount: 1, durationMinutes: 1 } },
      )
      .toArray(),
    Certificates().find({ userId: _id }).sort({ issuedAt: -1 }).toArray(),
    Payments()
      .find({ userId: _id }, { projection: { rawEvent: 0 } })
      .sort({ createdAt: -1 })
      .toArray(),
  ]);

  const courseMap = indexById(courses);

  return {
    user: publicUser(user),
    totals: {
      enrolled: enrollments.length,
      completed: enrollments.filter((e) => e.status === 'completed').length,
      certificates: certificates.length,
      spentKES: payments
        .filter((p) => p.status === 'paid')
        .reduce((sum, p) => sum + (p.amountKES ?? 0), 0),
    },
    courses: enrollments.map((enrollment) => {
      const course = courseMap.get(String(enrollment.courseId));
      return {
        enrollmentId: String(enrollment._id),
        courseId: String(enrollment.courseId),
        slug: course?.slug ?? null,
        title: course?.title ?? 'Removed course',
        status: enrollment.status,
        progressPct: enrollment.progressPct ?? 0,
        completedLessons: enrollment.completedLessons ?? 0,
        lessonCount: course?.lessonCount ?? 0,
        enrolledAt: enrollment.enrolledAt,
        lastAccessedAt: enrollment.lastAccessedAt ?? null,
        completedAt: enrollment.completedAt ?? null,
      };
    }),
    certificates: certificates.map((cert) => ({
      id: String(cert._id),
      serial: cert.serial,
      courseTitle: courseMap.get(String(cert.courseId))?.title ?? null,
      issuedAt: cert.issuedAt,
      hours: cert.hours ?? 0,
    })),
    payments: payments.map((p) => ({
      id: String(p._id),
      reference: p.reference,
      amountKES: p.amountKES,
      status: p.status,
      channel: p.channel ?? null,
      courseTitle: courseMap.get(String(p.courseId))?.title ?? null,
      createdAt: p.createdAt,
      paidAt: p.paidAt ?? null,
    })),
  };
}

export async function updateLearnerRole(userId, role) {
  const _id = toObjectId(userId, 'user id');
  const user = await Users().findOne({ _id });
  if (!user) throw ApiError.notFound('User not found');

  const $set = { role, updatedAt: new Date() };
  // Demoting away from instructor drops the profile link the ownership checks read.
  if (role === 'learner') $set.instructorProfileId = null;

  const updated = await Users().findOneAndUpdate(
    { _id },
    { $set },
    { returnDocument: 'after', projection: { passwordHash: 0 } },
  );

  return publicUser(updated);
}
