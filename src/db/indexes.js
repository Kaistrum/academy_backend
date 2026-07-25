import { getDb } from './client.js';
import { COLLECTIONS } from './collections.js';

/** Case-insensitive collation used by the anchored-regex people search (§4). */
export const CI_COLLATION = { locale: 'en', strength: 2 };

const INDEX_SPEC = {
  [COLLECTIONS.users]: [
    { key: { email: 1 }, unique: true, name: 'email_unique' },
    { key: { role: 1 }, name: 'role' },
    { key: { name: 1 }, name: 'name_ci', collation: CI_COLLATION },
    { key: { createdAt: -1 }, name: 'createdAt_desc' },
  ],

  [COLLECTIONS.authIdentities]: [
    { key: { provider: 1, providerAccountId: 1 }, unique: true, name: 'provider_account_unique' },
    { key: { userId: 1 }, name: 'userId' },
  ],

  [COLLECTIONS.refreshTokens]: [
    { key: { tokenHash: 1 }, unique: true, name: 'tokenHash_unique' },
    { key: { userId: 1 }, name: 'userId' },
    { key: { familyId: 1 }, name: 'familyId' },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'expiresAt_ttl' },
  ],

  [COLLECTIONS.oneTimeTokens]: [
    { key: { tokenHash: 1 }, unique: true, name: 'tokenHash_unique' },
    { key: { userId: 1, purpose: 1 }, name: 'userId_purpose' },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'expiresAt_ttl' },
  ],

  [COLLECTIONS.instructors]: [
    { key: { name: 1 }, name: 'name_ci', collation: CI_COLLATION },
    { key: { userId: 1 }, name: 'userId', sparse: true },
    { key: { name: 'text', title: 'text' }, name: 'instructor_text', weights: { name: 5, title: 1 } },
  ],

  [COLLECTIONS.tracks]: [
    { key: { slug: 1 }, unique: true, name: 'slug_unique' },
    { key: { sortOrder: 1 }, name: 'sortOrder' },
  ],

  [COLLECTIONS.courses]: [
    { key: { slug: 1 }, unique: true, name: 'slug_unique' },
    { key: { status: 1, publishedAt: -1 }, name: 'status_publishedAt' },
    { key: { trackId: 1 }, name: 'trackId' },
    { key: { instructorId: 1 }, name: 'instructorId' },
    { key: { featured: 1 }, name: 'featured' },
    { key: { ratingAvg: -1 }, name: 'ratingAvg_desc' },
    { key: { learnersCount: -1 }, name: 'learnersCount_desc' },
    { key: { durationMinutes: 1 }, name: 'durationMinutes' },
    { key: { title: 'text', summary: 'text' }, name: 'course_text', weights: { title: 10, summary: 2 } },
  ],

  [COLLECTIONS.lessons]: [
    { key: { courseId: 1, order: 1 }, name: 'courseId_order' },
    { key: { courseId: 1, sectionOrder: 1, order: 1 }, name: 'courseId_section_order' },
  ],

  [COLLECTIONS.enrollments]: [
    { key: { userId: 1, courseId: 1 }, unique: true, name: 'user_course_unique' },
    { key: { userId: 1, status: 1 }, name: 'userId_status' },
    { key: { courseId: 1 }, name: 'courseId' },
    { key: { userId: 1, lastAccessedAt: -1 }, name: 'userId_lastAccessed' },
  ],

  [COLLECTIONS.favourites]: [
    { key: { userId: 1, courseId: 1 }, unique: true, name: 'user_course_unique' },
    { key: { userId: 1, createdAt: -1 }, name: 'userId_createdAt' },
  ],

  [COLLECTIONS.reviews]: [
    { key: { userId: 1, courseId: 1 }, unique: true, name: 'user_course_unique' },
    { key: { courseId: 1, createdAt: -1 }, name: 'courseId_createdAt' },
    { key: { createdAt: -1 }, name: 'createdAt_desc' },
  ],

  [COLLECTIONS.certificates]: [
    { key: { userId: 1, courseId: 1 }, unique: true, name: 'user_course_unique' },
    { key: { serial: 1 }, unique: true, name: 'serial_unique' },
    { key: { userId: 1, issuedAt: -1 }, name: 'userId_issuedAt' },
  ],

  [COLLECTIONS.payments]: [
    { key: { reference: 1 }, unique: true, name: 'reference_unique' },
    { key: { userId: 1, createdAt: -1 }, name: 'userId_createdAt' },
    { key: { courseId: 1 }, name: 'courseId' },
    { key: { status: 1 }, name: 'status' },
    { key: { createdAt: -1 }, name: 'createdAt_desc' },
  ],

  [COLLECTIONS.auditLogs]: [
    { key: { actorId: 1, createdAt: -1 }, name: 'actor_createdAt' },
    { key: { targetType: 1, targetId: 1 }, name: 'target' },
    { key: { createdAt: -1 }, name: 'createdAt_desc' },
  ],
};

/**
 * Creates every index from the design doc. Idempotent: Mongo ignores requests
 * that match an existing index, and we surface (rather than swallow) a genuine
 * definition conflict so a changed spec doesn't silently keep the old index.
 */
export async function ensureIndexes() {
  const db = getDb();
  const created = [];

  for (const [collection, specs] of Object.entries(INDEX_SPEC)) {
    for (const spec of specs) {
      const { key, ...options } = spec;
      try {
        await db.collection(collection).createIndex(key, options);
        created.push(`${collection}.${options.name}`);
      } catch (err) {
        // 85 IndexOptionsConflict, 86 IndexKeySpecsConflict
        if (err.code === 85 || err.code === 86) {
          console.warn(
            `[indexes] ${collection}.${options.name} conflicts with an existing index — drop it manually to apply the new definition.`,
          );
        } else {
          throw err;
        }
      }
    }
  }

  return created.length;
}
