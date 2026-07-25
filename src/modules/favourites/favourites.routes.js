import { Router } from 'express';
import asyncHandler from '../../lib/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';
import { paginationQuery, query, slugParam, validate, z } from '../../middleware/validate.js';
import { sendData, sendList } from '../../utils/response.js';
import { addFavourite, listFavourites, removeFavourite } from './favourites.service.js';

const router = Router();

const slugParams = z.object({ slug: slugParam });

router.get(
  '/me/favourites',
  requireAuth,
  validate({ query: query(paginationQuery) }),
  asyncHandler(async (req, res) => {
    const { data, meta } = await listFavourites(req.user._id, req.valid.query);
    return sendList(res, data, meta);
  }),
);

router.put(
  '/courses/:slug/favourite',
  requireAuth,
  validate({ params: slugParams }),
  asyncHandler(async (req, res) =>
    sendData(res, await addFavourite(req.user._id, req.valid.params.slug)),
  ),
);

router.delete(
  '/courses/:slug/favourite',
  requireAuth,
  validate({ params: slugParams }),
  asyncHandler(async (req, res) =>
    sendData(res, await removeFavourite(req.user._id, req.valid.params.slug)),
  ),
);

export default router;
