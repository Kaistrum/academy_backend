import { Courses, Tracks } from '../../db/collections.js';
import ApiError from '../../lib/apiError.js';
import { publicTrack } from '../../lib/shape.js';
import { uniqueSlug } from '../../lib/slug.js';

export async function listTracks() {
  const tracks = await Tracks()
    .find({})
    .sort({ sortOrder: 1, name: 1 })
    .toArray();
  return tracks.map(publicTrack);
}

export async function getTrackBySlug(slug) {
  const track = await Tracks().findOne({ slug });
  if (!track) throw ApiError.notFound('Track not found');

  // Trust the live count on a single-document read; the cached field exists
  // for list responses where an extra count per row would be wasteful.
  const courseCount = await Courses().countDocuments({
    trackId: track._id,
    status: 'published',
  });

  return { ...publicTrack(track), courseCount };
}

export async function createTrack(payload) {
  const now = new Date();
  const doc = {
    slug: payload.slug
      ? await uniqueSlug(Tracks(), payload.slug)
      : await uniqueSlug(Tracks(), payload.name),
    name: payload.name.trim(),
    icon: payload.icon ?? null,
    blurb: payload.blurb ?? '',
    sortOrder: payload.sortOrder ?? 0,
    courseCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  const result = await Tracks().insertOne(doc);
  return publicTrack({ ...doc, _id: result.insertedId });
}

export async function updateTrack(slug, patch) {
  const track = await Tracks().findOne({ slug });
  if (!track) throw ApiError.notFound('Track not found');

  const $set = { updatedAt: new Date() };
  if (patch.name !== undefined) $set.name = patch.name.trim();
  if (patch.icon !== undefined) $set.icon = patch.icon || null;
  if (patch.blurb !== undefined) $set.blurb = patch.blurb;
  if (patch.sortOrder !== undefined) $set.sortOrder = patch.sortOrder;
  if (patch.slug !== undefined && patch.slug !== slug) {
    $set.slug = await uniqueSlug(Tracks(), patch.slug, track._id);
  }

  const updated = await Tracks().findOneAndUpdate(
    { _id: track._id },
    { $set },
    { returnDocument: 'after' },
  );
  return publicTrack(updated);
}

export async function deleteTrack(slug) {
  const track = await Tracks().findOne({ slug });
  if (!track) throw ApiError.notFound('Track not found');

  const inUse = await Courses().countDocuments({ trackId: track._id });
  if (inUse > 0) {
    throw ApiError.conflict(
      `This track still has ${inUse} course${inUse === 1 ? '' : 's'}. Move them to another track first.`,
    );
  }

  await Tracks().deleteOne({ _id: track._id });
  return { deleted: true, id: String(track._id) };
}
