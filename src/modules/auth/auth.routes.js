import { Router } from 'express';
import env from '../../config/env.js';
import asyncHandler from '../../lib/asyncHandler.js';
import { buildAuthorizeUrl, resolveOAuthProfile } from '../../lib/oauth.js';
import { publicUser } from '../../lib/shape.js';
import { requireAuth } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import { validate } from '../../middleware/validate.js';
import { sendData } from '../../utils/response.js';
import * as schema from './auth.schema.js';
import {
  REFRESH_COOKIE,
  clearRefreshCookie,
  consumeOAuthExchangeCode,
  consumeOAuthState,
  createOAuthExchangeCode,
  createOAuthState,
  loginUser,
  registerUser,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  revokeSession,
  rotateSession,
  setRefreshCookie,
  upsertOAuthUser,
  verifyEmail,
} from './auth.service.js';

const router = Router();

/**
 * The refresh token goes back two ways: an httpOnly cookie for browsers and
 * the response body for native clients (§5). Browser clients should ignore the
 * body copy and let the cookie do the work.
 */
function sendSession(res, session, status = 200) {
  setRefreshCookie(res, session.refreshToken, session.refreshExpiresAt);
  return sendData(
    res,
    {
      user: session.user,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      refreshExpiresAt: session.refreshExpiresAt,
    },
    status,
  );
}

router.post(
  '/auth/register',
  authLimiter,
  validate({ body: schema.registerBody }),
  asyncHandler(async (req, res) => {
    const session = await registerUser(req.valid.body, { req });
    return sendSession(res, session, 201);
  }),
);

router.post(
  '/auth/login',
  authLimiter,
  validate({ body: schema.loginBody }),
  asyncHandler(async (req, res) => {
    const session = await loginUser(req.valid.body, { req });
    return sendSession(res, session);
  }),
);

router.post(
  '/auth/refresh',
  validate({ body: schema.refreshBody }),
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE] ?? req.valid.body.refreshToken;
    const session = await rotateSession(token, { req });
    return sendSession(res, session);
  }),
);

router.post(
  '/auth/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    await revokeSession(req.cookies?.[REFRESH_COOKIE] ?? req.body?.refreshToken);
    clearRefreshCookie(res);
    return sendData(res, { loggedOut: true });
  }),
);

router.get(
  '/auth/me',
  requireAuth,
  asyncHandler(async (req, res) => sendData(res, { user: publicUser(req.user) })),
);

router.post(
  '/auth/verify-email',
  authLimiter,
  validate({ body: schema.tokenBody }),
  asyncHandler(async (req, res) => sendData(res, { user: await verifyEmail(req.valid.body.token) })),
);

router.post(
  '/auth/resend-verification',
  authLimiter,
  requireAuth,
  asyncHandler(async (req, res) => sendData(res, await resendVerification(req.user))),
);

router.post(
  '/auth/forgot-password',
  authLimiter,
  validate({ body: schema.forgotPasswordBody }),
  asyncHandler(async (req, res) =>
    sendData(res, await requestPasswordReset(req.valid.body.email)),
  ),
);

router.post(
  '/auth/reset-password',
  authLimiter,
  validate({ body: schema.resetPasswordBody }),
  asyncHandler(async (req, res) => sendData(res, await resetPassword(req.valid.body))),
);

// ---- OAuth -----------------------------------------------------------------

router.get(
  '/auth/oauth/:provider',
  validate({ params: schema.providerParams }),
  asyncHandler(async (req, res) => {
    const { provider } = req.valid.params;
    const state = createOAuthState(res, provider, req.query.returnTo);
    return res.redirect(buildAuthorizeUrl(provider, state));
  }),
);

router.get(
  '/auth/oauth/:provider/callback',
  validate({ params: schema.providerParams }),
  asyncHandler(async (req, res) => {
    const { provider } = req.valid.params;

    // The provider reports user-cancelled consent as a query param, not an error.
    if (req.query.error) {
      return res.redirect(
        `${env.APP_URL}/signin?error=${encodeURIComponent(String(req.query.error))}`,
      );
    }

    const state = consumeOAuthState(req, res, provider);
    const profile = await resolveOAuthProfile(provider, String(req.query.code ?? ''));
    const user = await upsertOAuthUser(provider, profile, { req });
    const code = await createOAuthExchangeCode(user._id);

    const target = new URL('/auth/callback', env.APP_URL);
    target.searchParams.set('code', code);
    if (state.returnTo) target.searchParams.set('returnTo', String(state.returnTo));
    return res.redirect(target.toString());
  }),
);

router.post(
  '/auth/oauth/exchange',
  authLimiter,
  validate({ body: schema.oauthExchangeBody }),
  asyncHandler(async (req, res) => {
    const session = await consumeOAuthExchangeCode(req.valid.body.code, { req });
    return sendSession(res, session);
  }),
);

/** Lets the sign-in screen hide buttons for providers that aren't configured. */
router.get('/auth/providers', (_req, res) =>
  sendData(res, { google: env.oauth.google, github: env.oauth.github }),
);

export default router;
