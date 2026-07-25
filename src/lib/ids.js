import { ObjectId } from 'mongodb';
import ApiError from './apiError.js';

export function isObjectId(value) {
  return ObjectId.isValid(value) && String(new ObjectId(value)) === String(value);
}

/** Parse an id from a URL param, rejecting garbage with a 404 rather than a 500. */
export function toObjectId(value, label = 'id') {
  if (!isObjectId(value)) {
    throw ApiError.notFound(`No resource matches the supplied ${label}`);
  }
  return new ObjectId(value);
}

/** Loose variant for optional filters — returns null instead of throwing. */
export function tryObjectId(value) {
  return isObjectId(value) ? new ObjectId(value) : null;
}

export function idsEqual(a, b) {
  if (!a || !b) return false;
  return String(a) === String(b);
}

export { ObjectId };
