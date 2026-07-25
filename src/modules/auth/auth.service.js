import crypto from 'node:crypto';
import env from '../../config/env.js';
import {
  AuthIdentities,
  OneTimeTokens,
  RefreshTokens,
  Users,
} from '../../db/collections.js';
import ApiError from '../../lib/apiError.js';
import { createOpaqueToken, hashToken, signAccessToken } from '../../lib/jwt.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { sendPasswordResetEmail, sendVerificationEmail } from '../../lib/mailer.js';
import { publicUser } from '../../lib/shape.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const VERIFY_TTL_MS = 24 * DAY_MS;

export const REFRESH_COOKIE = 'ka_refresh';

// ---- sessions --------------------------------------------------------------

function refreshLifetimeMs(remember) {
  const days = remember ? env.REFRESH_TTL_REMEMBER_DAYS : env.REFRESH_TTL_DAYS;
  return days * DAY_MS;
}

/**
 * Issues an access token plus a fresh refresh token. `familyId` ties every
 * rotation of one login together so a replayed token can revoke the whole
 * chain (§5).
 */
export async function issueSession(user, { remember = false, req, familyId } = {}) {
  const { raw, hash } = createOpaqueToken();
  const expiresAt = new Date(Date.now() + refreshLifetimeMs(remember));

  await RefreshTokens().insertOne({
    userId: user._id,
    tokenHash: hash,
    familyId: familyId ?? crypto.randomUUID(),
    remember,
    expiresAt,
    revokedAt: null,
    userAgent: req?.get('user-agent') ?? null,
    ip: req?.ip ?? null,
    createdAt: new Date(),
  });

  return {
    accessToken: signAccessToken(user),
    refreshToken: raw,
    refreshExpiresAt: expiresAt,
    user: publicUser(user),
  };
}

export function setRefreshCookie(res, token, expiresAt) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN,
    expires: expiresAt,
    path: '/api/v1/auth',
  });
}

export function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN,
    path: '/api/v1/auth',
  });
}

/**
 * Rotation with reuse detection: a token that is already revoked means someone
 * replayed a stolen copy, so the entire family is killed and the caller has to
 * sign in again.
 */
export async function rotateSession(rawToken, { req } = {}) {
  if (!rawToken) throw ApiError.unauthorized('Refresh token missing', 'REFRESH_MISSING');

  const stored = await RefreshTokens().findOne({ tokenHash: hashToken(rawToken) });
  if (!stored) throw ApiError.unauthorized('Refresh token is not valid', 'REFRESH_INVALID');

  if (stored.revokedAt) {
    await RefreshTokens().updateMany(
      { familyId: stored.familyId, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'reuse_detected' } },
    );
    throw ApiError.unauthorized('Session revoked — please sign in again', 'REFRESH_REUSED');
  }

  if (stored.expiresAt <= new Date()) {
    throw ApiError.unauthorized('Session expired — please sign in again', 'REFRESH_EXPIRED');
  }

  const user = await Users().findOne(
    { _id: stored.userId },
    { projection: { passwordHash: 0 } },
  );
  if (!user) throw ApiError.unauthorized('Account no longer exists', 'USER_NOT_FOUND');

  await RefreshTokens().updateOne(
    { _id: stored._id },
    { $set: { revokedAt: new Date(), revokedReason: 'rotated' } },
  );

  return issueSession(user, { remember: stored.remember, req, familyId: stored.familyId });
}

export async function revokeSession(rawToken) {
  if (!rawToken) return;
  await RefreshTokens().updateOne(
    { tokenHash: hashToken(rawToken), revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
  );
}

// ---- one-time tokens -------------------------------------------------------

async function issueOneTimeToken(userId, purpose, ttlMs) {
  const { raw, hash } = createOpaqueToken(32);
  await OneTimeTokens().deleteMany({ userId, purpose });
  await OneTimeTokens().insertOne({
    userId,
    purpose,
    tokenHash: hash,
    expiresAt: new Date(Date.now() + ttlMs),
    createdAt: new Date(),
  });
  return raw;
}

async function consumeOneTimeToken(rawToken, purpose) {
  const record = await OneTimeTokens().findOneAndDelete({
    tokenHash: hashToken(rawToken),
    purpose,
  });
  if (!record) throw ApiError.badRequest('This link is invalid or has already been used');
  if (record.expiresAt <= new Date()) throw ApiError.badRequest('This link has expired');
  return record;
}

// ---- registration & login --------------------------------------------------

export async function registerUser({ name, email, password }, { req } = {}) {
  const normalisedEmail = email.toLowerCase().trim();
  const now = new Date();

  const user = {
    name: name.trim(),
    email: normalisedEmail,
    passwordHash: await hashPassword(password),
    role: 'learner',
    avatarUrl: null,
    emailVerifiedAt: null,
    instructorProfileId: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const result = await Users().insertOne(user);
    user._id = result.insertedId;
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('An account with this email already exists');
    throw err;
  }

  const token = await issueOneTimeToken(user._id, 'email_verify', VERIFY_TTL_MS);
  await sendVerificationEmail({ to: user.email, name: user.name, token });

  return issueSession(user, { remember: false, req });
}

export async function loginUser({ email, password, remember }, { req } = {}) {
  const user = await Users().findOne({ email: email.toLowerCase().trim() });

  // One generic message for both branches — never confirm which addresses exist.
  const ok = user && (await verifyPassword(password, user.passwordHash));
  if (!ok) throw ApiError.unauthorized('Email or password is incorrect', 'INVALID_CREDENTIALS');

  delete user.passwordHash;
  return issueSession(user, { remember, req });
}

export async function verifyEmail(token) {
  const record = await consumeOneTimeToken(token, 'email_verify');
  await Users().updateOne(
    { _id: record.userId },
    { $set: { emailVerifiedAt: new Date(), updatedAt: new Date() } },
  );
  const user = await Users().findOne({ _id: record.userId }, { projection: { passwordHash: 0 } });
  return publicUser(user);
}

export async function resendVerification(user) {
  if (user.emailVerifiedAt) return { sent: false, reason: 'already_verified' };
  const token = await issueOneTimeToken(user._id, 'email_verify', VERIFY_TTL_MS);
  await sendVerificationEmail({ to: user.email, name: user.name, token });
  return { sent: true };
}

/** Always reports success: the response must not reveal whether an email exists. */
export async function requestPasswordReset(email) {
  const user = await Users().findOne({ email: email.toLowerCase().trim() });
  if (user) {
    const token = await issueOneTimeToken(user._id, 'password_reset', RESET_TTL_MS);
    await sendPasswordResetEmail({ to: user.email, name: user.name, token });
  }
  return { sent: true };
}

export async function resetPassword({ token, password }) {
  const record = await consumeOneTimeToken(token, 'password_reset');

  await Users().updateOne(
    { _id: record.userId },
    { $set: { passwordHash: await hashPassword(password), updatedAt: new Date() } },
  );

  // A password change invalidates every existing session.
  await RefreshTokens().updateMany(
    { userId: record.userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'password_reset' } },
  );

  return { reset: true };
}

// ---- oauth -----------------------------------------------------------------

/**
 * Links an OAuth identity to an account, creating the account on first sight.
 * An existing local account with the same verified email adopts the identity
 * rather than producing a duplicate user.
 */
export async function upsertOAuthUser(provider, profile, { req } = {}) {
  const identity = await AuthIdentities().findOne({
    provider,
    providerAccountId: profile.providerAccountId,
  });

  let user = identity
    ? await Users().findOne({ _id: identity.userId }, { projection: { passwordHash: 0 } })
    : null;

  if (!user && profile.email) {
    user = await Users().findOne({ email: profile.email }, { projection: { passwordHash: 0 } });
  }

  const now = new Date();

  if (!user) {
    const doc = {
      name: profile.name,
      email: profile.email,
      passwordHash: null,
      role: 'learner',
      avatarUrl: profile.avatarUrl,
      emailVerifiedAt: profile.emailVerified ? now : null,
      instructorProfileId: null,
      createdAt: now,
      updatedAt: now,
    };
    const result = await Users().insertOne(doc);
    user = { ...doc, _id: result.insertedId };
  } else if (!user.avatarUrl && profile.avatarUrl) {
    await Users().updateOne(
      { _id: user._id },
      { $set: { avatarUrl: profile.avatarUrl, updatedAt: now } },
    );
    user.avatarUrl = profile.avatarUrl;
  }

  if (!identity) {
    await AuthIdentities().updateOne(
      { provider, providerAccountId: profile.providerAccountId },
      { $set: { userId: user._id, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
  }

  return user;
}

/**
 * The OAuth callback is a browser redirect, so it cannot hand tokens back in a
 * response body — and putting them in the URL would leak them into history and
 * referrers. Instead it redirects with a two-minute single-use code that the
 * frontend swaps for a real session over POST.
 */
export function createOAuthExchangeCode(userId) {
  return issueOneTimeToken(userId, 'oauth_exchange', 2 * 60 * 1000);
}

export async function consumeOAuthExchangeCode(code, { req } = {}) {
  const record = await consumeOneTimeToken(code, 'oauth_exchange');
  const user = await Users().findOne(
    { _id: record.userId },
    { projection: { passwordHash: 0 } },
  );
  if (!user) throw ApiError.unauthorized('Account no longer exists', 'USER_NOT_FOUND');
  return issueSession(user, { remember: true, req });
}

// ---- oauth state cookie ----------------------------------------------------

export const OAUTH_STATE_COOKIE = 'ka_oauth_state';

export function createOAuthState(res, provider, returnTo) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const state = Buffer.from(JSON.stringify({ nonce, provider, returnTo })).toString('base64url');

  res.cookie(OAUTH_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax', // must survive the cross-site redirect back from the provider
    maxAge: 10 * 60 * 1000,
    path: '/api/v1/auth',
  });

  return state;
}

export function consumeOAuthState(req, res, provider) {
  const nonce = req.cookies?.[OAUTH_STATE_COOKIE];
  res.clearCookie(OAUTH_STATE_COOKIE, { path: '/api/v1/auth' });

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(String(req.query.state ?? ''), 'base64url').toString('utf8'));
  } catch {
    throw ApiError.badRequest('OAuth state is malformed');
  }

  if (!nonce || decoded.nonce !== nonce || decoded.provider !== provider) {
    throw ApiError.badRequest('OAuth state mismatch — please start sign-in again');
  }

  return decoded;
}
