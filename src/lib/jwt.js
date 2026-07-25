import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import ApiError from './apiError.js';

const ISSUER = 'kaistrum-academy';

export function signAccessToken(user) {
  return jwt.sign(
    {
      sub: String(user._id),
      role: user.role,
      email: user.email,
      ipid: user.instructorProfileId ? String(user.instructorProfileId) : null,
    },
    env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: env.ACCESS_TOKEN_TTL, issuer: ISSUER },
  );
}

export function verifyAccessToken(token) {
  try {
    return jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'], issuer: ISSUER });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw ApiError.unauthorized('Access token expired', 'TOKEN_EXPIRED');
    }
    throw ApiError.unauthorized('Invalid access token', 'TOKEN_INVALID');
  }
}

/** Opaque refresh tokens: random at rest on the client, SHA-256 in the database. */
export function createOpaqueToken(bytes = 48) {
  const raw = crypto.randomBytes(bytes).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
