import {
  objectIdParam,
  paginationQuery,
  query,
  searchQuery,
  strictObject,
  z,
} from '../../middleware/validate.js';

export const instructorIdParams = z.object({ id: objectIdParam });

export const instructorListQuery = query({
  ...paginationQuery,
  ...searchQuery,
  sort: z.enum(['az', 'za', 'rating', 'students', 'courses', 'recent']).optional(),
});

const profileFields = {
  name: z.string().trim().min(2).max(80),
  title: z.string().trim().max(120).optional(),
  bio: z.string().trim().max(2000).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  avatarUrl: z.union([z.url(), z.literal('')]).optional(),
  userId: z.union([objectIdParam, z.null()]).optional(),
};

export const createInstructorBody = strictObject(profileFields);

export const updateInstructorBody = strictObject({
  ...profileFields,
  name: profileFields.name.optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
