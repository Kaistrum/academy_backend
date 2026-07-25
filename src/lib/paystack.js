import crypto from 'node:crypto';
import env from '../config/env.js';
import ApiError from './apiError.js';

/**
 * Thin Paystack client. Money crosses this boundary in the smallest unit
 * (kobo/cents): everything inside the app stays in whole KES (§ "Money").
 */

export const toSubunit = (amountKES) => Math.round(amountKES * 100);
export const fromSubunit = (subunit) => Math.round(subunit / 100);

/**
 * Callers check this *before* writing a payment row, so a server without keys
 * fails fast instead of littering the ledger with abandoned attempts.
 */
export function assertConfigured() {
  if (!env.paystackEnabled) {
    throw new ApiError(503, 'PAYMENTS_UNAVAILABLE', 'Paystack is not configured on this server');
  }
}

async function call(path, { method = 'GET', body } = {}) {
  assertConfigured();

  const res = await fetch(`${env.PAYSTACK_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });

  let payload;
  try {
    payload = await res.json();
  } catch {
    throw new ApiError(502, 'PAYSTACK_ERROR', 'Paystack returned an unreadable response');
  }

  if (!res.ok || payload?.status === false) {
    throw new ApiError(
      res.status === 400 ? 400 : 502,
      'PAYSTACK_ERROR',
      payload?.message || 'Paystack rejected the request',
    );
  }

  return payload.data;
}

export function generateReference() {
  return `ka_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

export function initializeTransaction({ email, amountKES, reference, metadata, callbackUrl }) {
  return call('/transaction/initialize', {
    method: 'POST',
    body: {
      email,
      amount: toSubunit(amountKES),
      currency: env.CURRENCY,
      reference,
      metadata,
      callback_url: callbackUrl || env.PAYSTACK_CALLBACK_URL,
    },
  });
}

export function verifyTransaction(reference) {
  return call(`/transaction/verify/${encodeURIComponent(reference)}`);
}

export function refundTransaction({ reference, amountKES }) {
  return call('/refund', {
    method: 'POST',
    body: {
      transaction: reference,
      amount: amountKES ? toSubunit(amountKES) : undefined,
    },
  });
}

/**
 * HMAC-SHA512 of the *raw* body against the secret key. Must run before the
 * payload is parsed or trusted (§5).
 */
export function verifyWebhookSignature(rawBody, signature) {
  if (!env.paystackEnabled || !signature || !rawBody) return false;

  const expected = crypto
    .createHmac('sha512', env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
