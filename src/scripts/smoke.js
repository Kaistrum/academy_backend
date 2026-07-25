/**
 * End-to-end smoke test. Boots the API in-process against whatever
 * MONGODB_URI points at and walks the flows the frontend depends on:
 * auth → catalogue → enrolment → progress → review → certificate → admin.
 *
 *   pnpm seed:fresh && pnpm smoke
 *
 * Exits non-zero on the first hard failure so it can gate a deploy.
 */
import createApp from '../app.js';
import { closeDatabase, connectDatabase } from '../db/client.js';
import { ensureIndexes } from '../db/indexes.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.info(`  ok    ${name}`);
  } else {
    failed += 1;
    failures.push({ name, detail });
    console.error(`  FAIL  ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  }
}

function section(title) {
  console.info(`\n${title}`);
}

async function main() {
  await connectDatabase();
  await ensureIndexes();

  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;

  const call = async (method, path, { token, body, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, body: json, headers: res.headers };
  };

  try {
    // ---- infrastructure ----------------------------------------------------
    section('Infrastructure');
    const health = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    check('GET /health returns 200', health.status === 200);

    const root = await call('GET', '/');
    check('GET /api/v1 describes the API', root.body?.data?.name?.includes('Kaistrum'));

    const missing = await call('GET', '/definitely-not-a-route');
    check('unknown route returns the error envelope', missing.status === 404 && !!missing.body.error);

    // ---- auth --------------------------------------------------------------
    section('Auth');
    const email = `smoke_${Date.now()}@example.com`;

    const badRegister = await call('POST', '/auth/register', {
      body: { name: 'x', email: 'not-an-email', password: 'short' },
    });
    check(
      'register rejects bad input with 422 + fields',
      badRegister.status === 422 && Object.keys(badRegister.body.error.fields ?? {}).length >= 2,
      badRegister.body,
    );

    const register = await call('POST', '/auth/register', {
      body: { name: 'Smoke Learner', email, password: 'Passw0rd123' },
    });
    check('register returns 201 + tokens', register.status === 201 && !!register.body.data.accessToken, register.body);
    check('register never returns a password hash', !JSON.stringify(register.body).includes('passwordHash'));

    let learnerToken = register.body.data?.accessToken;
    const refreshToken = register.body.data?.refreshToken;

    const dupe = await call('POST', '/auth/register', {
      body: { name: 'Smoke Learner', email, password: 'Passw0rd123' },
    });
    check('duplicate email returns 409', dupe.status === 409, dupe.body);

    const me = await call('GET', '/auth/me', { token: learnerToken });
    check('GET /auth/me hydrates the caller', me.body?.data?.user?.email === email, me.body);

    const noAuth = await call('GET', '/auth/me');
    check('protected route without a token returns 401', noAuth.status === 401);

    const badToken = await call('GET', '/auth/me', { token: 'garbage.token.value' });
    check('invalid token returns 401', badToken.status === 401);

    const rotated = await call('POST', '/auth/refresh', { body: { refreshToken } });
    check('refresh rotates the session', rotated.status === 200 && !!rotated.body.data.accessToken, rotated.body);
    learnerToken = rotated.body.data?.accessToken ?? learnerToken;

    const replay = await call('POST', '/auth/refresh', { body: { refreshToken } });
    check('replaying a rotated refresh token is rejected', replay.status === 401, replay.body);

    const wrongPassword = await call('POST', '/auth/login', {
      body: { email, password: 'WrongPass123' },
    });
    check('wrong password returns 401', wrongPassword.status === 401);

    // ---- catalogue ---------------------------------------------------------
    section('Catalogue');
    const tracks = await call('GET', '/tracks');
    check('GET /tracks returns seeded tracks', Array.isArray(tracks.body.data) && tracks.body.data.length > 0, tracks.body);

    const courses = await call('GET', '/courses?pageSize=3&page=1');
    check('GET /courses paginates', courses.body.data?.length === 3 && courses.body.meta?.pageSize === 3, courses.body.meta);
    check('list rows omit heavy contentHTML', courses.body.data?.[0]?.contentHTML === undefined);

    const clamped = await call('GET', '/courses?pageSize=9999');
    check('pageSize is clamped to 100', clamped.body.meta?.pageSize === 100, clamped.body.meta);

    const badSort = await call('GET', '/courses?sort=%7B%22$where%22:1%7D');
    check('an unknown sort value is rejected, not passed to Mongo', badSort.status === 422, badSort.body);

    // Express 5's "simple" query parser never builds nested objects, so
    // `level[$ne]` arrives as a literal key that the allow-list drops — the
    // operator can't reach Mongo, and the list comes back unfiltered.
    const baseline = await call('GET', '/courses?pageSize=100');
    const injection = await call('GET', '/courses?level[$ne]=beginner&pageSize=100');
    check(
      'operator-shaped query params never reach Mongo',
      injection.status === 200 && injection.body.meta.total === baseline.body.meta.total,
      { injected: injection.body.meta, baseline: baseline.body.meta },
    );

    const injectedBody = await call('POST', '/auth/login', {
      body: { email: { $ne: null }, password: { $ne: null } },
    });
    check('operator objects in a JSON body are rejected', injectedBody.status === 422, injectedBody.body);

    const search = await call('GET', '/courses?q=remote%20sensing');
    check('text search finds the Sentinel course', search.body.data?.some((c) => c.slug === 'remote-sensing-with-sentinel'), search.body.data?.map((c) => c.slug));

    const freeOnly = await call('GET', '/courses?access=free');
    check('access=free filters to free courses', freeOnly.body.data?.every((c) => c.premium === false), freeOnly.body.data?.map((c) => c.premium));

    const byTrack = await call('GET', '/courses?category=remote-sensing');
    check('category filter maps slug → trackId', byTrack.body.data?.length > 0 && byTrack.body.data.every((c) => c.track?.slug === 'remote-sensing' || c.trackId), byTrack.body.data?.length);

    const unknownCategory = await call('GET', '/courses?category=does-not-exist');
    check('an unknown category returns nothing rather than everything', unknownCategory.body.meta?.total === 0, unknownCategory.body.meta);

    const featured = await call('GET', '/courses/featured');
    check('featured courses are returned', featured.body.data?.length > 0 && featured.body.data.every((c) => c.featured));

    const detail = await call('GET', '/courses/introduction-to-gis');
    check('course detail includes embedded lists', Array.isArray(detail.body.data?.whatYouLearn) && detail.body.data.whatYouLearn.length > 0);
    check('anonymous detail has no enrollment', detail.body.data?.enrollment === null);

    const related = await call('GET', '/courses/introduction-to-gis/related');
    check('related courses exclude the course itself', related.body.data?.every((c) => c.slug !== 'introduction-to-gis'));

    // ---- access control on lessons ----------------------------------------
    section('Lesson access control');
    const anonCurriculum = await call('GET', '/courses/introduction-to-gis/curriculum');
    const allLessons = anonCurriculum.body.data?.sections?.flatMap((s) => s.lessons) ?? [];
    const previewLesson = allLessons.find((l) => l.isPreview);
    const lockedLesson = allLessons.find((l) => !l.isPreview);

    check('curriculum marks non-preview lessons locked for anonymous users', lockedLesson?.locked === true);
    check('preview lessons are not locked', previewLesson?.locked === false);

    const previewRead = await call('GET', `/courses/introduction-to-gis/lessons/${previewLesson.id}`);
    check('a preview lesson body is readable anonymously', previewRead.status === 200 && typeof previewRead.body.data.contentHTML === 'string');

    const lockedRead = await call('GET', `/courses/introduction-to-gis/lessons/${lockedLesson.id}`);
    check('a locked lesson body returns 403', lockedRead.status === 403 && lockedRead.body.error.code === 'LESSON_LOCKED', lockedRead.body);

    // ---- enrolment & progress ---------------------------------------------
    section('Enrolment and progress');
    const enroll = await call('POST', '/courses/introduction-to-gis/enroll', { token: learnerToken });
    check('enrolling in a free course succeeds', enroll.status === 201, enroll.body);

    const enrollAgain = await call('POST', '/courses/introduction-to-gis/enroll', { token: learnerToken });
    check('enrolling twice is idempotent', enrollAgain.status === 200 && enrollAgain.body.data.alreadyEnrolled === true);

    const premiumEnroll = await call('POST', '/courses/fundamentals-of-arcgis/enroll', { token: learnerToken });
    check('a premium course returns 402 with checkout details', premiumEnroll.status === 402 && !!premiumEnroll.body.error.checkout, premiumEnroll.body);

    const checkout = await call('POST', '/courses/fundamentals-of-arcgis/checkout', { token: learnerToken });
    check('checkout reports 503 while Paystack is unconfigured', checkout.status === 503, checkout.body);

    const unlockedRead = await call('GET', `/courses/introduction-to-gis/lessons/${lockedLesson.id}`, { token: learnerToken });
    check('the same lesson is readable once enrolled', unlockedRead.status === 200, unlockedRead.body?.error);

    const enrollmentId = enroll.body.data?.enrollment?.id;
    const curriculum = await call('GET', '/courses/introduction-to-gis/curriculum', { token: learnerToken });
    const lessonIds = curriculum.body.data.sections.flatMap((s) => s.lessons).map((l) => l.id);

    const firstComplete = await call('PUT', `/enrollments/${enrollmentId}/lessons/${lessonIds[0]}/complete`, { token: learnerToken });
    check('marking a lesson complete recomputes progress', firstComplete.body.data?.progressPct > 0, firstComplete.body);

    const uncomplete = await call('DELETE', `/enrollments/${enrollmentId}/lessons/${lessonIds[0]}/complete`, { token: learnerToken });
    check('un-completing a lesson lowers progress again', uncomplete.body.data?.progressPct === 0, uncomplete.body);

    const foreign = await call('PUT', `/enrollments/${enrollmentId}/lessons/${lessonIds[0]}/complete`, { token: null });
    check('progress updates require authentication', foreign.status === 401);

    let lastProgress = null;
    for (const lessonId of lessonIds) {
      lastProgress = await call('PUT', `/enrollments/${enrollmentId}/lessons/${lessonId}/complete`, { token: learnerToken });
    }
    check('finishing every lesson reaches 100%', lastProgress.body.data?.progressPct === 100, lastProgress.body.data);
    check('the enrollment flips to completed', lastProgress.body.data?.status === 'completed');
    check('no next lesson remains', lastProgress.body.data?.nextLesson === null);

    const stats = await call('GET', '/users/me/stats', { token: learnerToken });
    check('dashboard stats count the completion', stats.body.data?.completed === 1 && stats.body.data?.lessonsDone === lessonIds.length, stats.body.data);
    check('hoursLearned is derived from lesson minutes', stats.body.data?.hoursLearned > 0);

    // ---- favourites --------------------------------------------------------
    section('Favourites');
    const fav = await call('PUT', '/courses/remote-sensing-with-sentinel/favourite', { token: learnerToken });
    check('saving a course works', fav.body.data?.isFavourite === true, fav.body);

    const favAgain = await call('PUT', '/courses/remote-sensing-with-sentinel/favourite', { token: learnerToken });
    check('saving twice is idempotent', favAgain.status === 200);

    const favList = await call('GET', '/me/favourites', { token: learnerToken });
    check('the favourites list returns the course card', favList.body.data?.[0]?.slug === 'remote-sensing-with-sentinel', favList.body);

    const unfav = await call('DELETE', '/courses/remote-sensing-with-sentinel/favourite', { token: learnerToken });
    check('unsaving works', unfav.body.data?.isFavourite === false);

    // ---- reviews -----------------------------------------------------------
    section('Reviews');
    const gatedReview = await call('POST', '/courses/remote-sensing-with-sentinel/reviews', {
      token: learnerToken,
      body: { rating: 5, body: 'Not enrolled in this one, so this should fail.' },
    });
    check('reviewing a course you never took returns 403', gatedReview.status === 403, gatedReview.body);

    const review = await call('POST', '/courses/introduction-to-gis/reviews', {
      token: learnerToken,
      body: { rating: 5, body: 'Clear explanations and the QGIS exercises actually worked.' },
    });
    check('reviewing a completed course succeeds', review.status === 201, review.body);

    const dupeReview = await call('POST', '/courses/introduction-to-gis/reviews', {
      token: learnerToken,
      body: { rating: 4, body: 'Trying to review the same course twice.' },
    });
    check('a second review for the same course returns 409', dupeReview.status === 409, dupeReview.body);

    const reviewList = await call('GET', '/courses/introduction-to-gis/reviews');
    check('the review list carries the rating summary', reviewList.body.summary?.count === 1 && reviewList.body.summary?.histogram?.[5] === 1, reviewList.body.summary);

    const courseAfterReview = await call('GET', '/courses/introduction-to-gis');
    check('the cached course rating was refreshed', courseAfterReview.body.data?.ratingAvg === 5 && courseAfterReview.body.data?.ratingCount === 1, {
      avg: courseAfterReview.body.data?.ratingAvg,
      count: courseAfterReview.body.data?.ratingCount,
    });

    const editReview = await call('PATCH', `/reviews/${review.body.data.id}`, {
      token: learnerToken,
      body: { rating: 4 },
    });
    check('editing your own review works', editReview.body.data?.rating === 4, editReview.body);

    // ---- certificates ------------------------------------------------------
    section('Certificates');
    const cert = await call('POST', '/courses/introduction-to-gis/certificate', { token: learnerToken });
    check('a certificate is issued on completion', cert.status === 201 && !!cert.body.data?.serial, cert.body);

    const certAgain = await call('POST', '/courses/introduction-to-gis/certificate', { token: learnerToken });
    check('issuing twice returns the same certificate', certAgain.status === 200 && certAgain.body.data.serial === cert.body.data.serial);

    const verify = await call('GET', `/certificates/verify/${cert.body.data.serial}`);
    check('public verification resolves the serial', verify.body.data?.valid === true && verify.body.data.courseTitle === 'Introduction to GIS', verify.body);

    const verifyBogus = await call('GET', '/certificates/verify/KA-1999-DEADBEEF');
    check('an unknown serial returns 404', verifyBogus.status === 404);

    const svg = await fetch(`${base}/certificates/${cert.body.data.id}/download?format=svg`, {
      headers: { Authorization: `Bearer ${learnerToken}` },
    });
    const svgText = await svg.text();
    check('the SVG certificate renders', svg.status === 200 && svgText.startsWith('<svg') && svgText.includes(cert.body.data.serial));

    const pdf = await fetch(`${base}/certificates/${cert.body.data.id}/download?format=pdf`, {
      headers: { Authorization: `Bearer ${learnerToken}` },
    });
    const pdfBuf = Buffer.from(await pdf.arrayBuffer());
    check('the PDF certificate renders', pdf.status === 200 && pdfBuf.subarray(0, 4).toString() === '%PDF' && pdfBuf.length > 1000);

    const certs = await call('GET', '/me/certificates', { token: learnerToken });
    check('my certificates lists it with the course', certs.body.data?.[0]?.course?.slug === 'introduction-to-gis', certs.body);

    // ---- my learning -------------------------------------------------------
    section('My learning');
    const myEnrollments = await call('GET', '/me/enrollments', { token: learnerToken });
    check('my learning returns the course card and certificate serial', myEnrollments.body.data?.[0]?.course?.slug === 'introduction-to-gis' && !!myEnrollments.body.data[0].certificateSerial, myEnrollments.body.data?.[0]);

    const orders = await call('GET', '/me/orders', { token: learnerToken });
    check(
      'an unavailable checkout leaves no row in the ledger',
      orders.body.data?.length === 0,
      orders.body.data,
    );

    // ---- admin -------------------------------------------------------------
    section('Admin and instructor back office');
    const adminLogin = await call('POST', '/auth/login', {
      body: { email: 'admin@kaistrum.com', password: 'Admin12345', remember: true },
    });
    check('the seeded admin can sign in', adminLogin.status === 200, adminLogin.body);
    const adminToken = adminLogin.body.data?.accessToken;

    const learnerBlocked = await call('GET', '/admin/overview', { token: learnerToken });
    check('a learner cannot reach the back office', learnerBlocked.status === 403, learnerBlocked.body);

    const overview = await call('GET', '/admin/overview', { token: adminToken });
    check('the dashboard returns KPIs', typeof overview.body.data?.totalRevenueKES === 'number' && overview.body.data.publishedCourses > 0, overview.body.data);
    check('revenueByMonth always has 12 buckets', overview.body.data?.revenueByMonth?.length === 12);

    const tutorList = await call('GET', '/admin/tutors', { token: adminToken });
    check('the tutor directory is readable', tutorList.body.data?.length > 0, tutorList.body);

    const noInstructor = await call('POST', '/admin/courses', {
      token: adminToken,
      body: { title: 'Missing tutor', format: 'tutorial', level: 'beginner' },
    });
    check('creating a course without an instructor is rejected', noInstructor.status === 400, noInstructor.body);

    const created = await call('POST', '/admin/courses', {
      token: adminToken,
      body: {
        title: 'Smoke Test Course',
        format: 'tutorial',
        level: 'beginner',
        summary: 'Created by the smoke test.',
        trackId: 'mapping',
        instructorId: tutorList.body.data[0].id,
      },
    });
    check('an admin can create a course', created.status === 201 && created.body.data.status === 'draft', created.body);

    const draftSlug = created.body.data?.slug;
    const publicDraft = await call('GET', `/courses/${draftSlug}`);
    check('a draft course is invisible to the public', publicDraft.status === 404);

    const premiumWithoutPrice = await call('PATCH', `/admin/courses/${draftSlug}`, {
      token: adminToken,
      body: { premium: true },
    });
    check('marking a course premium without a price is rejected', premiumWithoutPrice.status === 400, premiumWithoutPrice.body);

    const priced = await call('PATCH', `/admin/courses/${draftSlug}`, {
      token: adminToken,
      body: { premium: true, priceKES: 5900, originalPriceKES: 9900 },
    });
    check('pricing in whole KES is stored as-is', priced.body.data?.priceKES === 5900, priced.body);

    const lesson = await call('POST', `/admin/courses/${draftSlug}/lessons`, {
      token: adminToken,
      body: { title: 'Smoke lesson one', minutes: 15, sectionTitle: 'Intro', sectionOrder: 0 },
    });
    check('a lesson can be added', lesson.status === 201, lesson.body);

    const lesson2 = await call('POST', `/admin/courses/${draftSlug}/lessons`, {
      token: adminToken,
      body: { title: 'Smoke lesson two', minutes: 25, sectionTitle: 'Intro', sectionOrder: 0 },
    });
    check('a second lesson appends after the first', lesson2.body.data?.order === 1, lesson2.body);

    const afterLessons = await call('GET', `/admin/courses/${draftSlug}`, { token: adminToken });
    check('course duration and lesson count are recomputed', afterLessons.body.data?.durationMinutes === 40 && afterLessons.body.data?.lessonCount === 2, afterLessons.body.data);

    const reorder = await call('PATCH', `/admin/courses/${draftSlug}/lessons/reorder`, {
      token: adminToken,
      body: { lessons: [{ id: lesson2.body.data.id, order: 0 }, { id: lesson.body.data.id, order: 1 }] },
    });
    check('lessons can be reordered', reorder.body.data?.[0]?.id === lesson2.body.data.id, reorder.body.data?.map((l) => l.title));

    const published = await call('PATCH', `/admin/courses/${draftSlug}`, {
      token: adminToken,
      body: { status: 'published' },
    });
    check('publishing stamps publishedAt', published.body.data?.status === 'published' && !!published.body.data?.publishedAt);

    const nowPublic = await call('GET', `/courses/${draftSlug}`);
    check('the published course is now public', nowPublic.status === 200);

    const roster = await call('GET', '/admin/courses/introduction-to-gis/learners', { token: adminToken });
    check('the course roster lists the learner with progress', roster.body.data?.some((r) => r.email === email && r.progressPct === 100), roster.body.data);

    const learners = await call('GET', '/admin/learners?q=Smoke', { token: adminToken });
    check('learner search finds the account', learners.body.data?.some((l) => l.email === email), learners.body.meta);

    const learnersLower = await call('GET', '/admin/learners?q=smoke', { token: adminToken });
    check('learner search is case-insensitive', learnersLower.body.data?.some((l) => l.email === email), learnersLower.body.meta);

    const rosterSearch = await call('GET', '/admin/courses/introduction-to-gis/learners?q=smoke', { token: adminToken });
    check('roster search is case-insensitive too', rosterSearch.body.data?.some((r) => r.email === email), rosterSearch.body.meta);

    const learnerDetail = await call('GET', `/admin/learners/${me.body.data.user.id}`, { token: adminToken });
    check('learner detail spans their courses and certificates', learnerDetail.body.data?.totals?.completed === 1 && learnerDetail.body.data?.certificates?.length === 1, learnerDetail.body.data?.totals);

    const moderation = await call('GET', '/admin/reviews', { token: adminToken });
    check('the moderation queue includes the review with its course', moderation.body.data?.[0]?.course?.slug === 'introduction-to-gis', moderation.body.data?.[0]);

    const ledger = await call('GET', '/admin/payments', { token: adminToken });
    check('the payments ledger returns a revenue summary', typeof ledger.body.summary?.revenueKES === 'number', ledger.body.summary);

    // ---- instructor scoping ------------------------------------------------
    section('Instructor ownership scoping');
    const tutorLogin = await call('POST', '/auth/login', {
      body: { email: 'grace.wanjiru@kaistrum.com', password: 'Tutor12345' },
    });
    check('the seeded instructor can sign in', tutorLogin.status === 200, tutorLogin.body);
    const tutorToken = tutorLogin.body.data?.accessToken;

    const tutorCourses = await call('GET', '/admin/courses', { token: tutorToken });
    check('an instructor only sees their own courses', tutorCourses.body.data?.length > 0 && tutorCourses.body.data.every((c) => c.instructor?.name === 'Dr. Grace Wanjiru'), tutorCourses.body.data?.map((c) => c.instructor?.name));

    const foreignCourse = await call('PATCH', '/admin/courses/web-mapping-with-geoserver', {
      token: tutorToken,
      body: { title: 'Hijacked' },
    });
    check("an instructor cannot edit another tutor's course", foreignCourse.status === 403, foreignCourse.body);

    const tutorTracks = await call('POST', '/admin/tracks', {
      token: tutorToken,
      body: { name: 'Should not be allowed' },
    });
    check('track management stays admin-only', tutorTracks.status === 403, tutorTracks.body);

    // ---- cleanup -----------------------------------------------------------
    section('Cleanup');
    const del = await call('DELETE', `/admin/courses/${draftSlug}`, { token: adminToken });
    check('a course with no learners can be deleted', del.body.data?.deleted === true, del.body);

    const delEnrolled = await call('DELETE', '/admin/courses/introduction-to-gis', { token: adminToken });
    check('a course with learners refuses deletion', delEnrolled.status === 409, delEnrolled.body);
  } finally {
    server.close();
    await closeDatabase();
  }

  console.info(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f.name}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(async (err) => {
  console.error('Smoke run crashed:', err);
  await closeDatabase().catch(() => {});
  process.exit(1);
});
