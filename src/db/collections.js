import { getDb } from './client.js';

export const COLLECTIONS = Object.freeze({
  users: 'users',
  authIdentities: 'authIdentities',
  refreshTokens: 'refreshTokens',
  oneTimeTokens: 'oneTimeTokens',
  instructors: 'instructors',
  tracks: 'tracks',
  courses: 'courses',
  lessons: 'lessons',
  enrollments: 'enrollments',
  favourites: 'favourites',
  reviews: 'reviews',
  certificates: 'certificates',
  payments: 'payments',
  auditLogs: 'auditLogs',
});

const accessor = (name) => () => getDb().collection(name);

export const Users = accessor(COLLECTIONS.users);
export const AuthIdentities = accessor(COLLECTIONS.authIdentities);
export const RefreshTokens = accessor(COLLECTIONS.refreshTokens);
export const OneTimeTokens = accessor(COLLECTIONS.oneTimeTokens);
export const Instructors = accessor(COLLECTIONS.instructors);
export const Tracks = accessor(COLLECTIONS.tracks);
export const Courses = accessor(COLLECTIONS.courses);
export const Lessons = accessor(COLLECTIONS.lessons);
export const Enrollments = accessor(COLLECTIONS.enrollments);
export const Favourites = accessor(COLLECTIONS.favourites);
export const Reviews = accessor(COLLECTIONS.reviews);
export const Certificates = accessor(COLLECTIONS.certificates);
export const Payments = accessor(COLLECTIONS.payments);
export const AuditLogs = accessor(COLLECTIONS.auditLogs);
