import { Router } from 'express';
import asyncHandler from '../../lib/asyncHandler.js';
import { publicUser } from '../../lib/shape.js';
import { requireAuth } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import { strictObject, validate, z } from '../../middleware/validate.js';
import { sendData } from '../../utils/response.js';
import { passwordField } from '../auth/auth.schema.js';
import { changePassword, getStats, updateProfile } from './users.service.js';

const router = Router();

const updateProfileBody = strictObject({
  name: z.string().trim().min(2).max(80).optional(),
  avatarUrl: z.union([z.url('Enter a valid URL'), z.literal('')]).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

const changePasswordBody = strictObject({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: passwordField,
});

router.get(
  '/users/me',
  requireAuth,
  asyncHandler(async (req, res) => sendData(res, publicUser(req.user))),
);

router.patch(
  '/users/me',
  requireAuth,
  validate({ body: updateProfileBody }),
  asyncHandler(async (req, res) => sendData(res, await updateProfile(req.user._id, req.valid.body))),
);

router.patch(
  '/users/me/password',
  requireAuth,
  authLimiter,
  validate({ body: changePasswordBody }),
  asyncHandler(async (req, res) =>
    sendData(res, await changePassword(req.user._id, req.valid.body)),
  ),
);

router.get(
  '/users/me/stats',
  requireAuth,
  asyncHandler(async (req, res) => sendData(res, await getStats(req.user._id))),
);

export default router;
