import { Router } from 'express';
import asyncHandler from '../../lib/asyncHandler.js';
import { verifyWebhookSignature } from '../../lib/paystack.js';
import { requireAuth } from '../../middleware/auth.js';
import { paymentsLimiter, webhookLimiter } from '../../middleware/rateLimit.js';
import {
  paginationQuery,
  query,
  slugParam,
  validate,
  z,
} from '../../middleware/validate.js';
import { sendData, sendList } from '../../utils/response.js';
import { handleWebhookEvent, listMyOrders, startCheckout, verifyPayment } from './payments.service.js';

const router = Router();

const referenceParams = z.object({
  reference: z.string().trim().min(6).max(120).regex(/^[A-Za-z0-9_.-]+$/),
});

const ordersQuery = query({
  ...paginationQuery,
  status: z.enum(['pending', 'paid', 'failed', 'refunded', 'abandoned']).optional(),
  sort: z.enum(['recent', 'oldest', 'amountHigh', 'amountLow']).optional(),
});

router.post(
  '/courses/:slug/checkout',
  requireAuth,
  paymentsLimiter,
  validate({ params: z.object({ slug: slugParam }) }),
  asyncHandler(async (req, res) =>
    sendData(res, await startCheckout(req.valid.params.slug, req.user), 201),
  ),
);

router.get(
  '/payments/:reference/verify',
  requireAuth,
  paymentsLimiter,
  validate({ params: referenceParams }),
  asyncHandler(async (req, res) =>
    sendData(res, await verifyPayment(req.valid.params.reference, req.user)),
  ),
);

/**
 * Paystack callback. The HMAC is checked against the raw body captured by the
 * JSON parser's `verify` hook — an unsigned or altered payload never reaches
 * the handler (§5).
 */
router.post(
  '/payments/webhook',
  webhookLimiter,
  asyncHandler(async (req, res) => {
    const signature = req.get('x-paystack-signature');

    if (!verifyWebhookSignature(req.rawBody, signature)) {
      return res.status(401).json({
        error: { code: 'INVALID_SIGNATURE', message: 'Webhook signature verification failed' },
      });
    }

    // Always 200 on a signed event: a non-2xx makes Paystack retry, and an
    // event we do not model is not a failure.
    const result = await handleWebhookEvent(req.body);
    return res.status(200).json({ received: true, ...result });
  }),
);

router.get(
  '/me/orders',
  requireAuth,
  validate({ query: ordersQuery }),
  asyncHandler(async (req, res) => {
    const { data, meta } = await listMyOrders(req.user._id, req.valid.query);
    return sendList(res, data, meta);
  }),
);

export default router;
