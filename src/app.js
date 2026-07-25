import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import env from './config/env.js';
import { errorHandler, notFound } from './middleware/error.js';
import { globalLimiter } from './middleware/rateLimit.js';
import sanitize from './middleware/sanitize.js';
import api from './modules/index.js';

export function createApp() {
  const app = express();

  // Rate limiting and audit logs read req.ip, so the proxy hop count has to be
  // explicit — trusting every hop would let a client spoof its own address.
  app.set('trust proxy', env.isProd ? 1 : false);
  app.disable('x-powered-by');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header: same-origin, curl, or a server-to-server call.
        if (!origin) return callback(null, true);
        if (env.CORS_ORIGINS.includes(origin) || env.CORS_ORIGINS.includes('*')) {
          return callback(null, true);
        }
        return callback(new Error('CORS_NOT_ALLOWED'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  );

  app.use(morgan(env.isProd ? 'combined' : 'dev'));

  app.use(
    express.json({
      limit: env.JSON_BODY_LIMIT,
      // The Paystack webhook signs the exact bytes it sent, so the raw body is
      // kept alongside the parsed one for HMAC verification (§5).
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: env.JSON_BODY_LIMIT }));
  app.use(cookieParser());
  app.use(sanitize);

  app.get('/health', (_req, res) =>
    res.json({ status: 'ok', uptime: process.uptime(), env: env.NODE_ENV }),
  );

  app.use('/api/v1', globalLimiter, api);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export default createApp;
