import { slugParam, strictObject, z } from '../../middleware/validate.js';

export const trackSlugParams = z.object({ slug: slugParam });

export const createTrackBody = strictObject({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/i).max(80).optional(),
  icon: z.string().trim().max(40).optional(),
  blurb: z.string().trim().max(400).optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
});

export const updateTrackBody = strictObject({
  name: z.string().trim().min(2).max(80).optional(),
  slug: z.string().trim().regex(/^[a-z0-9-]+$/i).max(80).optional(),
  icon: z.string().trim().max(40).optional(),
  blurb: z.string().trim().max(400).optional(),
  sortOrder: z.coerce.number().int().min(0).max(999).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
