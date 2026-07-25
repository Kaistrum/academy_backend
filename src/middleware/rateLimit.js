import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import env from '../config/env.js';

const envelope = (code, message) => (req, res) =>
  res.status(429).json({ error: { code, message } });

const base = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Health checks shouldn't burn anyone's budget.
  skip: (req) => req.path === '/health',
};

/** Global bucket applied to the whole API. */
export const globalLimiter = rateLimit({
  ...base,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  handler: envelope('RATE_LIMITED', 'Too many requests — please slow down'),
});

/**
 * Stricter bucket for credential endpoints. Keyed on IP *and* the submitted
 * email so one noisy network cannot lock out an unrelated account, and so
 * repeated guesses at a single account back off regardless of source IP.
 */
export const authLimiter = rateLimit({
  ...base,
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  keyGenerator: (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : '';
    return `${ipKeyGenerator(req, res)}:${email}`;
  },
  handler: envelope('AUTH_RATE_LIMITED', 'Too many attempts — try again in a few minutes'),
});

export const paymentsLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 20,
  handler: envelope('RATE_LIMITED', 'Too many payment requests — please wait a moment'),
});

export const webhookLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 240,
  handler: envelope('RATE_LIMITED', 'Webhook rate limit exceeded'),
});

export const writeLimiter = rateLimit({
  ...base,
  windowMs: 60_000,
  limit: 60,
  handler: envelope('RATE_LIMITED', 'Too many writes — please wait a moment'),
});
