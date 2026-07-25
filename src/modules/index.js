import { Router } from 'express';
import env from '../config/env.js';
import adminRoutes from './admin/admin.routes.js';
import authRoutes from './auth/auth.routes.js';
import certificatesRoutes from './certificates/certificates.routes.js';
import coursesRoutes from './courses/courses.routes.js';
import enrollmentsRoutes from './enrollments/enrollments.routes.js';
import favouritesRoutes from './favourites/favourites.routes.js';
import instructorsRoutes from './instructors/instructors.routes.js';
import paymentsRoutes from './payments/payments.routes.js';
import reviewsRoutes from './reviews/reviews.routes.js';
import tracksRoutes from './tracks/tracks.routes.js';
import usersRoutes from './users/users.routes.js';

/**
 * Every module declares its own full paths (`/courses/:slug/enroll` lives with
 * enrollments, not courses), so all routers mount flat on the `/api/v1` base.
 */
const api = Router();

api.get('/', (_req, res) =>
  res.json({
    data: {
      name: 'Kaistrum Academy API',
      version: 'v1',
      docs: '/api/v1/health',
      features: {
        oauth: env.oauth,
        payments: env.paystackEnabled ? 'paystack' : 'disabled',
        mail: env.mailEnabled ? 'smtp' : 'console',
      },
    },
  }),
);

api.use(authRoutes);
api.use(usersRoutes);
api.use(tracksRoutes);
api.use(instructorsRoutes);
api.use(coursesRoutes);
api.use(enrollmentsRoutes);
api.use(favouritesRoutes);
api.use(reviewsRoutes);
api.use(certificatesRoutes);
api.use(paymentsRoutes);
api.use(adminRoutes);

export default api;
