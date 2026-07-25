import { Users } from '../db/collections.js';
import ApiError from '../lib/apiError.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { toObjectId } from '../lib/ids.js';

function bearerToken(req) {
  const header = req.get('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!/^Bearer$/i.test(scheme) || !token) return null;
  return token.trim();
}

/**
 * The user is re-read on every request rather than trusted from the token, so
 * a role change or deletion takes effect without waiting for the access token
 * to expire.
 */
async function loadUser(token) {
  const claims = verifyAccessToken(token);
  const user = await Users().findOne(
    { _id: toObjectId(claims.sub, 'user id') },
    { projection: { passwordHash: 0 } },
  );
  if (!user) throw ApiError.unauthorized('Account no longer exists', 'USER_NOT_FOUND');
  return user;
}

/** 🔒 — rejects anonymous callers. */
export async function requireAuth(req, _res, next) {
  try {
    const token = bearerToken(req);
    if (!token) throw ApiError.unauthorized('Sign in to continue');
    req.user = await loadUser(token);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * "opt" in the endpoint table: the route works anonymously but returns extra
 * caller-specific fields when a valid token is present. A bad token is treated
 * as anonymous rather than as an error.
 */
export async function optionalAuth(req, _res, next) {
  try {
    const token = bearerToken(req);
    req.user = token ? await loadUser(token) : null;
  } catch {
    req.user = null;
  }
  next();
}

/** 🛠 / 👑 — role gate, applied after requireAuth. */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(ApiError.unauthorized('Sign in to continue'));
    if (!roles.includes(req.user.role)) {
      return next(ApiError.forbidden('Your account does not have access to this area'));
    }
    return next();
  };
}

export const requireAdmin = requireRole('admin');
export const requireStaff = requireRole('instructor', 'admin');

export const isAdmin = (user) => user?.role === 'admin';
