import env from '../../config/env.js';
import { Courses, Enrollments, Payments, Users } from '../../db/collections.js';
import ApiError from '../../lib/apiError.js';
import { recomputeCourseLearners } from '../../lib/aggregates.js';
import { toObjectId, tryObjectId } from '../../lib/ids.js';
import { dateRange, paginate, resolveSort } from '../../lib/listQuery.js';
import { sendEnrollmentEmail } from '../../lib/mailer.js';
import {
  assertConfigured as assertPaystackConfigured,
  fromSubunit,
  generateReference,
  initializeTransaction,
  refundTransaction,
  verifyTransaction,
} from '../../lib/paystack.js';
import { indexById, publicPayment } from '../../lib/shape.js';
import { createEnrollment } from '../enrollments/enrollments.service.js';

const PENDING_REUSE_WINDOW_MS = 30 * 60 * 1000;

const PAYMENT_SORTS = {
  recent: { createdAt: -1 },
  oldest: { createdAt: 1 },
  amountHigh: { amountKES: -1 },
  amountLow: { amountKES: 1 },
};

// ---- checkout --------------------------------------------------------------

/**
 * Reads the authoritative price from the course document — never from the
 * request — and creates a `pending` payment whose `reference` doubles as the
 * Paystack idempotency key (§7).
 */
export async function startCheckout(slug, user) {
  // Fail before touching the ledger, so a misconfigured server does not leave
  // an abandoned payment row behind on every attempt.
  assertPaystackConfigured();

  const course = await Courses().findOne({ slug, status: 'published' });
  if (!course) throw ApiError.notFound('Course not found');

  if (!course.premium) {
    throw ApiError.badRequest('This course is free — enrol directly instead of checking out');
  }
  if (!course.priceKES || course.priceKES <= 0) {
    throw ApiError.conflict('This course has no price set. Please contact support.');
  }

  const alreadyEnrolled = await Enrollments().findOne(
    { userId: user._id, courseId: course._id },
    { projection: { _id: 1 } },
  );
  if (alreadyEnrolled) {
    throw ApiError.conflict('You already have access to this course', 'ALREADY_ENROLLED');
  }

  // Re-offer a recent pending attempt rather than stacking references for the
  // same intent — the learner may simply have closed the Paystack tab.
  const reusable = await Payments().findOne({
    userId: user._id,
    courseId: course._id,
    status: 'pending',
    amountKES: course.priceKES,
    authorizationUrl: { $ne: null },
    createdAt: { $gte: new Date(Date.now() - PENDING_REUSE_WINDOW_MS) },
  });

  if (reusable) {
    return {
      authorizationUrl: reusable.authorizationUrl,
      reference: reusable.reference,
      amountKES: reusable.amountKES,
      currency: 'KES',
      reused: true,
    };
  }

  const reference = generateReference();
  const now = new Date();

  await Payments().insertOne({
    userId: user._id,
    courseId: course._id,
    amountKES: course.priceKES,
    provider: 'paystack',
    reference,
    providerRef: null,
    channel: null,
    status: 'pending',
    authorizationUrl: null,
    paidAt: null,
    rawEvent: null,
    createdAt: now,
    updatedAt: now,
  });

  let paystack;
  try {
    paystack = await initializeTransaction({
      email: user.email,
      amountKES: course.priceKES,
      reference,
      metadata: {
        userId: String(user._id),
        courseId: String(course._id),
        courseSlug: course.slug,
        courseTitle: course.title,
      },
      callbackUrl: env.PAYSTACK_CALLBACK_URL || `${env.APP_URL}/checkout/callback`,
    });
  } catch (err) {
    await Payments().updateOne(
      { reference },
      { $set: { status: 'abandoned', updatedAt: new Date() } },
    );
    throw err;
  }

  await Payments().updateOne(
    { reference },
    {
      $set: {
        authorizationUrl: paystack.authorization_url,
        providerRef: paystack.reference ?? null,
        updatedAt: new Date(),
      },
    },
  );

  return {
    authorizationUrl: paystack.authorization_url,
    accessCode: paystack.access_code ?? null,
    reference,
    amountKES: course.priceKES,
    currency: 'KES',
    reused: false,
  };
}

// ---- settlement ------------------------------------------------------------

/**
 * The single place a payment becomes `paid` and access is granted. Both the
 * client verify call and the webhook funnel through here, and it is safe to
 * run twice for the same reference.
 */
async function settlePayment(payment, { providerRef, channel, rawEvent, paidAt }) {
  if (payment.status === 'paid') {
    const enrollment = await createEnrollment({
      userId: payment.userId,
      courseId: payment.courseId,
      paymentId: payment._id,
    });
    return { payment, enrollment, newlyPaid: false };
  }

  const updated = await Payments().findOneAndUpdate(
    { _id: payment._id, status: { $ne: 'paid' } },
    {
      $set: {
        status: 'paid',
        providerRef: providerRef ?? payment.providerRef,
        channel: channel ?? payment.channel,
        paidAt: paidAt ?? new Date(),
        rawEvent: rawEvent ?? payment.rawEvent,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );

  const current = updated ?? (await Payments().findOne({ _id: payment._id }));

  const enrollment = await createEnrollment({
    userId: current.userId,
    courseId: current.courseId,
    paymentId: current._id,
  });

  if (updated) {
    const [user, course] = await Promise.all([
      Users().findOne({ _id: current.userId }, { projection: { name: 1, email: 1 } }),
      Courses().findOne({ _id: current.courseId }, { projection: { title: 1, slug: 1 } }),
    ]);
    if (user && course) {
      await sendEnrollmentEmail({
        to: user.email,
        name: user.name,
        courseTitle: course.title,
        slug: course.slug,
      }).catch(() => {});
    }
  }

  return { payment: current, enrollment, newlyPaid: Boolean(updated) };
}

export async function verifyPayment(reference, user) {
  const payment = await Payments().findOne({ reference });
  if (!payment) throw ApiError.notFound('Payment not found');

  if (String(payment.userId) !== String(user._id) && user.role !== 'admin') {
    throw ApiError.forbidden('This payment belongs to another account');
  }

  const data = await verifyTransaction(reference);

  if (data.status !== 'success') {
    const status = data.status === 'abandoned' ? 'abandoned' : 'failed';
    await Payments().updateOne(
      { _id: payment._id, status: 'pending' },
      { $set: { status, channel: data.channel ?? null, updatedAt: new Date() } },
    );
    throw ApiError.badRequest(
      data.gateway_response || 'Payment was not completed',
      { status: data.status },
    );
  }

  // Guard against a tampered or mismatched charge before granting access.
  const paidKES = fromSubunit(data.amount ?? 0);
  if (paidKES < payment.amountKES) {
    throw ApiError.badRequest('The amount paid does not match the course price');
  }

  const settled = await settlePayment(payment, {
    providerRef: String(data.id ?? data.reference ?? ''),
    channel: data.channel ?? null,
    paidAt: data.paid_at ? new Date(data.paid_at) : new Date(),
    rawEvent: data,
  });

  const course = await Courses().findOne(
    { _id: settled.payment.courseId },
    { projection: { title: 1, slug: 1 } },
  );

  return {
    payment: publicPayment(settled.payment, { course }),
    enrolled: true,
    newlyPaid: settled.newlyPaid,
  };
}

/**
 * Webhook handling (§7 step 3): the source of truth. Signature verification
 * happens in the route before the body is parsed; this half is idempotent on
 * `reference` so replays are harmless.
 */
export async function handleWebhookEvent(event) {
  const reference = event?.data?.reference;
  if (!reference) return { ignored: true, reason: 'no_reference' };

  const payment = await Payments().findOne({ reference });
  if (!payment) return { ignored: true, reason: 'unknown_reference' };

  switch (event.event) {
    case 'charge.success': {
      const paidKES = fromSubunit(event.data.amount ?? 0);
      if (paidKES < payment.amountKES) {
        await Payments().updateOne(
          { _id: payment._id },
          { $set: { status: 'failed', rawEvent: event, updatedAt: new Date() } },
        );
        return { handled: true, action: 'amount_mismatch' };
      }

      const settled = await settlePayment(payment, {
        providerRef: String(event.data.id ?? ''),
        channel: event.data.channel ?? null,
        paidAt: event.data.paid_at ? new Date(event.data.paid_at) : new Date(),
        rawEvent: event,
      });
      return { handled: true, action: settled.newlyPaid ? 'paid' : 'already_paid' };
    }

    case 'charge.failed': {
      await Payments().updateOne(
        { _id: payment._id, status: 'pending' },
        { $set: { status: 'failed', rawEvent: event, updatedAt: new Date() } },
      );
      return { handled: true, action: 'failed' };
    }

    case 'refund.processed':
    case 'refund.pending':
    case 'refund.failed': {
      if (event.event !== 'refund.processed') {
        await Payments().updateOne(
          { _id: payment._id },
          { $set: { rawEvent: event, updatedAt: new Date() } },
        );
        return { handled: true, action: 'refund_noted' };
      }

      await Payments().updateOne(
        { _id: payment._id },
        { $set: { status: 'refunded', rawEvent: event, updatedAt: new Date() } },
      );
      // Policy: a refund revokes access.
      await Enrollments().deleteOne({ userId: payment.userId, courseId: payment.courseId });
      await recomputeCourseLearners(payment.courseId);
      return { handled: true, action: 'refunded' };
    }

    default:
      return { ignored: true, reason: `unhandled_event:${event.event}` };
  }
}

// ---- ledger reads ----------------------------------------------------------

async function attachCourses(payments) {
  const courses = await Courses()
    .find(
      { _id: { $in: payments.map((p) => p.courseId).filter(Boolean) } },
      { projection: { title: 1, slug: 1, instructorId: 1 } },
    )
    .toArray();
  const courseMap = indexById(courses);
  return payments.map((p) => publicPayment(p, { course: courseMap.get(String(p.courseId)) }));
}

export async function listMyOrders(userId, params = {}) {
  const filter = { userId };
  if (params.status) filter.status = params.status;

  const { data, meta } = await paginate(Payments(), {
    filter,
    sort: resolveSort(PAYMENT_SORTS, params.sort, 'recent'),
    projection: { rawEvent: 0 },
    page: params.page,
    pageSize: params.pageSize,
  });

  return { data: await attachCourses(data), meta };
}

/** Admin ledger (§6.11). Instructors see only payments for their own courses. */
export async function listPayments(params, user) {
  const filter = {};

  if (user.role !== 'admin') {
    if (!user.instructorProfileId) {
      throw ApiError.forbidden('Your account is not linked to an instructor profile');
    }
    const owned = await Courses()
      .find({ instructorId: user.instructorProfileId }, { projection: { _id: 1 } })
      .toArray();
    filter.courseId = { $in: owned.map((c) => c._id) };
  }

  if (params.status) filter.status = params.status;
  if (params.channel) filter.channel = params.channel;

  if (params.course) {
    const course = await Courses().findOne(
      { slug: params.course },
      { projection: { _id: 1 } },
    );
    filter.courseId = course ? course._id : null;
  }

  const range = dateRange(params.dateFrom, params.dateTo);
  if (range) filter.createdAt = range;

  const { data, meta } = await paginate(Payments(), {
    filter,
    sort: resolveSort(PAYMENT_SORTS, params.sort, 'recent'),
    projection: { rawEvent: 0 },
    page: params.page,
    pageSize: params.pageSize,
  });

  const [rows, totals] = await Promise.all([
    attachCourses(data),
    Payments()
      .aggregate([
        { $match: { ...filter, status: 'paid' } },
        { $group: { _id: null, revenueKES: { $sum: '$amountKES' }, count: { $sum: 1 } } },
      ])
      .toArray(),
  ]);

  const learners = await Users()
    .find(
      { _id: { $in: data.map((p) => p.userId).filter(Boolean) } },
      { projection: { name: 1, email: 1 } },
    )
    .toArray();
  const learnerMap = indexById(learners);

  return {
    data: rows.map((row, i) => {
      const learner = learnerMap.get(String(data[i].userId));
      return {
        ...row,
        learner: learner
          ? { id: String(learner._id), name: learner.name, email: learner.email }
          : null,
      };
    }),
    meta,
    summary: {
      paidCount: totals[0]?.count ?? 0,
      revenueKES: totals[0]?.revenueKES ?? 0,
    },
  };
}

export async function refundPayment(id, { reason } = {}) {
  const payment = await Payments().findOne({ _id: toObjectId(id, 'payment id') });
  if (!payment) throw ApiError.notFound('Payment not found');

  if (payment.status !== 'paid') {
    throw ApiError.conflict(`Only paid transactions can be refunded (this one is ${payment.status})`);
  }

  const data = await refundTransaction({ reference: payment.reference });

  await Payments().updateOne(
    { _id: payment._id },
    {
      $set: {
        status: 'refunded',
        refundedAt: new Date(),
        refundReason: reason ?? null,
        rawEvent: data,
        updatedAt: new Date(),
      },
    },
  );

  // Access is revoked with the refund; the webhook repeats this harmlessly.
  await Enrollments().deleteOne({ userId: payment.userId, courseId: payment.courseId });
  await recomputeCourseLearners(payment.courseId);

  const course = await Courses().findOne(
    { _id: payment.courseId },
    { projection: { title: 1, slug: 1 } },
  );

  return publicPayment({ ...payment, status: 'refunded' }, { course });
}

export function parseCourseFilter(slugOrId) {
  return tryObjectId(slugOrId) ? { _id: tryObjectId(slugOrId) } : { slug: slugOrId };
}
