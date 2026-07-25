# Kaistrum Academy — Backend

Express 5 API on MongoDB (official `mongodb` driver, no ODM) implementing the contract in
`backend-schema.md`: public catalogue with server-side search/filter/sort/pagination, Tiptap lesson
player with access gating, enrolments and progress, favourites, completion-gated reviews,
certificates, Paystack checkout in KES, and the admin/instructor back office.

## Quick start

```bash
pnpm install
cp .env.example .env          # then set MONGODB_URI and JWT_SECRET
pnpm seed:fresh               # sample tracks, tutors, courses, lessons, accounts
pnpm dev                      # http://localhost:4000/api/v1
```

Seeded logins:

| Role | Email | Password |
|------|-------|----------|
| admin | `admin@kaistrum.com` | `Admin12345` |
| instructor | `grace.wanjiru@kaistrum.com` | `Tutor12345` |
| learner | `learner@kaistrum.com` | `Learner12345` |

`pnpm smoke` boots the API in-process against the configured `MONGODB_URI` and runs 93 end-to-end
assertions across auth, the catalogue, lesson gating, enrolment and progress, favourites, reviews,
certificates and the admin back office. It exits non-zero on the first failure, so it can gate a
deploy. Run it after `pnpm seed:fresh` and point it at a throwaway database — it writes.

## Conventions

- Base URL `/api/v1`, JSON in and out.
- Single: `{ "data": { … } }` · List: `{ "data": [ … ], "meta": { page, pageSize, total, totalPages, hasNext, hasPrev } }`
- Error: `{ "error": { "code": "…", "message": "…", "fields"?: { field: message } } }`
- Auth header `Authorization: Bearer <accessToken>`. 🔒 signed in · 🛠 instructor or admin · 👑 admin.
- Documents expose `id` (string), never `_id`. Timestamps are UTC ISO strings.
- Money is whole KES integers everywhere; the conversion to kobo happens only inside the Paystack client.
- Unknown query params are ignored; unknown body fields are rejected with `422`.
- `page` defaults to 1, `pageSize` to 12 and is clamped to 100.

## Auth model

Register or sign in returns a short-lived **access token** (15 min) plus a rotating **refresh token**.
The refresh token is delivered two ways so both browsers and native clients work:

- an `httpOnly` cookie `ka_refresh`, scoped to `/api/v1/auth`
- the same value in the response body

Browser clients should ignore the body copy and just call `POST /auth/refresh` with credentials
included. Every refresh rotates the token; presenting an already-rotated token revokes the whole
session family, so a stolen token is usable at most once.

**OAuth**: `GET /auth/oauth/google` redirects to the provider. The callback lands on
`{APP_URL}/auth/callback?code=…` with a single-use, two-minute code — the frontend posts it to
`POST /auth/oauth/exchange` to receive a normal session. Tokens never appear in a URL.
`GET /auth/providers` reports which buttons to show.

## Endpoints

### Auth `/auth`
| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| POST | `/auth/register` | — | name, email, password → user + tokens, sends verification mail |
| POST | `/auth/login` | — | email, password, `remember` → tokens |
| POST | `/auth/refresh` | — | rotate refresh (cookie or body) |
| POST | `/auth/logout` | 🔒 | revoke the current refresh token |
| GET | `/auth/me` | 🔒 | hydrate the signed-in nav |
| POST | `/auth/verify-email` | — | consume the verification token |
| POST | `/auth/resend-verification` | 🔒 | send it again |
| POST | `/auth/forgot-password` | — | email a reset link (always reports success) |
| POST | `/auth/reset-password` | — | consume the token, set a new password, revoke sessions |
| GET | `/auth/oauth/:provider` | — | begin Google/GitHub sign-in |
| GET | `/auth/oauth/:provider/callback` | — | provider redirect → `{APP_URL}/auth/callback?code=` |
| POST | `/auth/oauth/exchange` | — | swap that code for a session |
| GET | `/auth/providers` | — | which providers are configured |

### Users `/users`
`GET /users/me` 🔒 · `PATCH /users/me` 🔒 (name, avatarUrl) · `PATCH /users/me/password` 🔒 ·
`GET /users/me/stats` 🔒 → `{ enrolled, inProgress, notStarted, completed, certificates, lessonsDone, minutesLearned, hoursLearned }`

### Tracks `/tracks`
`GET /tracks` · `GET /tracks/:slug` · `POST` / `PATCH /tracks/:slug` / `DELETE /tracks/:slug` 👑
(a track holding courses refuses deletion with `409`).

### Instructors `/instructors`
`GET /instructors/:id` · `GET /instructors/:id/courses` · `GET /instructors` 🛠 (admins see all,
instructors see themselves) · `POST` / `PATCH /:id` / `DELETE /:id` 👑.

### Courses `/courses`
| Method | Path | Auth | Notes |
|--------|------|:----:|-------|
| GET | `/courses` | — | `q, category, format, level, access, sort, page, pageSize` — published only |
| GET | `/courses/featured` | — | `limit` (default 6) |
| GET | `/courses/:slug` | opt | adds `enrollment`, `isFavourite`, `hasAccess` when signed in |
| GET | `/courses/:slug/related` | — | more from the same track |
| GET | `/courses/:slug/curriculum` | opt | sections → lessons with `locked` and `completed` |
| GET | `/courses/:slug/lessons/:lessonId` | opt | body + video; `403 LESSON_LOCKED` when gated |
| GET | `/courses/:slug/reviews` | — | list plus `summary: { average, count, histogram }` |

Filters: `category` is a track slug, `access` is `free`\|`premium`, `format` is
`web_course`\|`training_seminar`\|`tutorial`\|`learning_path`, `level` is
`beginner`\|`intermediate`\|`advanced`.
Sorts: `recent`, `newest`, `rating`, `popular`, `az`, `za`, `shortest`, `longest`, `priceLow`,
`priceHigh`, and `relevance` (the default whenever `q` is present).

### Enrolments and progress
`GET /me/enrollments` 🔒 (course card + progress + `nextLesson` + `certificateSerial`) ·
`POST /courses/:slug/enroll` 🔒 · `GET /courses/:slug/enrollment` 🔒 ·
`PUT|DELETE /enrollments/:id/lessons/:lessonId/complete` 🔒 · `DELETE /enrollments/:id` 🔒.

A premium course answers `POST .../enroll` with `402` and a `checkout` block:

```json
{ "error": { "code": "PAYMENT_REQUIRED", "message": "…",
  "checkout": { "slug": "…", "priceKES": 12500, "currency": "KES", "checkoutUrl": "/api/v1/courses/…/checkout" } } }
```

Progress is always recomputed server-side from `completedLessonIds`; a client-sent `progressPct` is
ignored. Hitting every lesson flips the enrollment to `completed` and unlocks the certificate.

### Favourites
`GET /me/favourites` 🔒 · `PUT /courses/:slug/favourite` 🔒 · `DELETE /courses/:slug/favourite` 🔒.
Both writes are idempotent.

### Reviews
`POST /courses/:slug/reviews` 🔒 — requires a **completed** enrollment, otherwise `403`
(`NOT_ENROLLED` or `COURSE_NOT_COMPLETED`); one per course (`409` on a second).
`PATCH /reviews/:id` 🔒 own · `DELETE /reviews/:id` 🔒 own or admin.

### Certificates
`GET /me/certificates` 🔒 · `POST /courses/:slug/certificate` 🔒 (idempotent) ·
`GET /certificates/:id` 🔒 · `GET /certificates/:id/download?format=svg|pdf` 🔒 ·
`GET /certificates/verify/:serial` — public, returns learner name, course and issue date only.

### Payments (Paystack, KES)
| Method | Path | Auth | Purpose |
|--------|------|:----:|---------|
| POST | `/courses/:slug/checkout` | 🔒 | → `{ authorizationUrl, reference, amountKES }`, creates a `pending` payment |
| GET | `/payments/:reference/verify` | 🔒 | server-side verify → mark paid + enrol |
| POST | `/payments/webhook` | signed | `x-paystack-signature` HMAC-SHA512 over the raw body |
| GET | `/me/orders` | 🔒 | purchase history |

Verify and webhook are complementary and both idempotent on `reference`; whichever confirms first
grants access, and the `{userId, courseId}` unique index prevents a double enrolment. A recent
pending attempt for the same course is re-offered instead of creating a second reference.

Point your Paystack dashboard webhook at `{API_URL}/api/v1/payments/webhook`.

### Admin and instructor back office `/admin`
All routes need 🛠; the ones marked 👑 are admin-only. Instructors are ownership-scoped — every
course and lesson mutation checks `course.instructorId === user.instructorProfileId`, and lists are
filtered the same way.

| Method | Path | Auth |
|--------|------|:----:|
| GET | `/admin/overview` | 🛠 |
| GET POST | `/admin/courses` | 🛠 |
| GET PATCH DELETE | `/admin/courses/:slug` | 🛠 |
| GET POST | `/admin/courses/:slug/lessons` | 🛠 |
| PATCH | `/admin/courses/:slug/lessons/reorder` | 🛠 |
| GET PATCH DELETE | `/admin/courses/:slug/lessons/:id` | 🛠 |
| GET | `/admin/courses/:slug/learners` | 🛠 |
| GET | `/admin/learners`, `/admin/learners/:userId` | 👑 |
| PATCH | `/admin/learners/:userId/role` | 👑 |
| GET DELETE | `/admin/reviews`, `/admin/reviews/:id` | 🛠 |
| GET | `/admin/payments` | 🛠 |
| POST | `/admin/payments/:id/refund` | 👑 |
| GET POST PATCH DELETE | `/admin/tutors[/:id]` | 👑 |
| GET POST PATCH DELETE | `/admin/tracks[/:slug]` | 👑 |

`GET /admin/overview` returns `totalRevenueKES`, `growthMoM`, `publishedCourses`, `draftCourses`,
`tutors`, `enrollments`, `completions`, a 12-bucket `revenueByMonth`, `topCourses`, `topTutors` and
`recentOrders`. An instructor gets the identical shape computed over their own courses.

Deleting a course with enrolled learners returns `409` — unpublish instead. Refunds revoke access.

## How it is built

```
src/
  app.js                 helmet, CORS allow-list, JSON + raw-body capture, sanitiser, rate limits
  server.js              boot, index creation, graceful shutdown
  config/env.js          zod-validated environment; the process refuses to start on a bad config
  db/                    MongoClient singleton, collection accessors, index definitions
  middleware/            auth, validate, sanitize, rateLimit, ownCourse, error
  lib/                   jwt, password, listQuery, paystack, oauth, mailer, certificate,
                         aggregates (cached counters), shape (response serialisers), audit
  modules/<feature>/     <feature>.routes.js · .service.js · .schema.js
  scripts/               seed.js, smoke.js
```

Routers declare full paths (`/courses/:slug/enroll` lives with enrolments, not courses) and all
mount flat on `/api/v1`.

**Reads** use projections that exclude `contentHTML` from list responses, and `paginate()`
centralises skip/limit + count + whitelisted sort so no endpoint can be handed a raw Mongo sort or
filter. **Cached counters** (`durationMinutes`, `lessonCount`, `ratingAvg`, `ratingCount`,
`learnersCount`, `courseCount`, instructor totals) are denormalised onto their parent and rebuilt
from source on every relevant write, so a missed increment self-heals.

### Validation

`validate({ body, query, params })` parses with Zod and publishes the result on `req.valid`.
Handlers read `req.valid.query`, never `req.query` — only allow-listed, coerced values reach a
service, and it sidesteps Express 5's read-only query getter. Bodies reject unknown keys.

### Security

Argon2-grade hashing is not used; passwords are bcrypt at cost 12 (`BCRYPT_ROUNDS`). Access tokens
are HS256 JWTs; refresh tokens are opaque random values stored only as SHA-256 hashes, rotated on
every use with reuse detection. Login and registration sit behind an IP+email rate-limit bucket, and
failed logins return one generic message so the API never confirms which addresses exist.

NoSQL injection is blocked in three layers: Express 5's `simple` query parser never builds nested
objects, so `?level[$ne]=x` arrives as one literal key rather than an operator; the Zod allow-list
then drops it; and a recursive sanitiser strips `$`-prefixed and dotted keys from bodies and params
for anything that gets past both. The webhook verifies
its HMAC against the raw request bytes before the payload is trusted. Locked lesson bodies return
`403` unless the caller is enrolled, the lesson is a preview, or the caller manages the course.

### Transactions

The code deliberately avoids multi-document transactions so it runs against a standalone `mongod`.
Correctness comes from unique indexes (`{userId, courseId}` on enrollments, favourites, reviews and
certificates; `reference` on payments) plus idempotent upserts.

## Configuration

Every variable is documented in `.env.example`. The essentials are `MONGODB_URI`, `MONGODB_DB`,
`JWT_SECRET`, `APP_URL`, `API_URL` and `CORS_ORIGINS`. Optional blocks degrade gracefully:

- **No Paystack key** — checkout and refunds return `503 PAYMENTS_UNAVAILABLE`; everything else works.
- **No SMTP** — verification and reset links print to the server console.
- **No OAuth credentials** — those providers report `false` from `GET /auth/providers` and their
  routes return `503`.

If the API and frontend are on different sites in production, set `COOKIE_SAMESITE=none`,
`COOKIE_SECURE=true` and serve over HTTPS, or have the client hold the refresh token itself.
