import env from '../config/env.js';
import ApiError from './apiError.js';

/**
 * Minimal Google / GitHub authorization-code flow. No passport: each provider
 * needs one redirect, one token exchange and one profile read, and doing it
 * directly keeps the identity mapping (§2.2) explicit.
 */

export const PROVIDERS = ['google', 'github'];

const CONFIG = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    profileUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
  },
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    profileUrl: 'https://api.github.com/user',
    scope: 'read:user user:email',
  },
};

export function assertProviderEnabled(provider) {
  if (!PROVIDERS.includes(provider)) {
    throw ApiError.notFound(`Unknown OAuth provider "${provider}"`);
  }
  if (!env.oauth[provider]) {
    throw new ApiError(503, 'OAUTH_UNAVAILABLE', `${provider} sign-in is not configured`);
  }
}

export function redirectUri(provider) {
  return `${env.API_URL}/api/v1/auth/oauth/${provider}/callback`;
}

function credentials(provider) {
  return provider === 'google'
    ? { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET }
    : { id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET };
}

export function buildAuthorizeUrl(provider, state) {
  assertProviderEnabled(provider);
  const cfg = CONFIG[provider];
  const { id } = credentials(provider);

  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(provider),
    scope: cfg.scope,
    state,
    response_type: 'code',
  });

  if (provider === 'google') {
    params.set('access_type', 'offline');
    params.set('prompt', 'select_account');
  }

  return `${cfg.authorizeUrl}?${params.toString()}`;
}

async function exchangeCodeForToken(provider, code) {
  const cfg = CONFIG[provider];
  const { id, secret } = credentials(provider);

  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: id,
      client_secret: secret,
      code,
      redirect_uri: redirectUri(provider),
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.access_token) {
    throw ApiError.unauthorized('OAuth code exchange failed', 'OAUTH_EXCHANGE_FAILED');
  }
  return payload.access_token;
}

async function fetchProfile(provider, accessToken) {
  const cfg = CONFIG[provider];
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'User-Agent': 'kaistrum-academy',
  };

  const res = await fetch(cfg.profileUrl, { headers, signal: AbortSignal.timeout(15_000) });
  const profile = await res.json().catch(() => null);
  if (!res.ok || !profile) {
    throw ApiError.unauthorized('Could not read the OAuth profile', 'OAUTH_PROFILE_FAILED');
  }

  if (provider === 'google') {
    return {
      providerAccountId: String(profile.sub),
      email: profile.email?.toLowerCase() ?? null,
      emailVerified: Boolean(profile.email_verified),
      name: profile.name || profile.email?.split('@')[0] || 'Learner',
      avatarUrl: profile.picture ?? null,
    };
  }

  // GitHub hides the address unless it is public — the /user/emails scope has it.
  let email = profile.email?.toLowerCase() ?? null;
  let emailVerified = false;
  if (!email) {
    const emailsRes = await fetch('https://api.github.com/user/emails', {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const emails = await emailsRes.json().catch(() => []);
    const primary = Array.isArray(emails)
      ? emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified)
      : null;
    email = primary?.email?.toLowerCase() ?? null;
    emailVerified = Boolean(primary?.verified);
  }

  if (!email) {
    throw ApiError.badRequest('Your GitHub account has no verified email address');
  }

  return {
    providerAccountId: String(profile.id),
    email,
    emailVerified,
    name: profile.name || profile.login || 'Learner',
    avatarUrl: profile.avatar_url ?? null,
  };
}

export async function resolveOAuthProfile(provider, code) {
  assertProviderEnabled(provider);
  const accessToken = await exchangeCodeForToken(provider, code);
  return fetchProfile(provider, accessToken);
}
