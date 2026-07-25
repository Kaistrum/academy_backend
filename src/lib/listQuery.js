import { buildMeta } from '../utils/response.js';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 12;

export function clampPaging({ page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const p = Math.max(1, Math.trunc(Number(page) || 1));
  const s = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(pageSize) || DEFAULT_PAGE_SIZE)));
  return { page: p, pageSize: s, skip: (p - 1) * s };
}

/**
 * Resolves a client `sort` key against a whitelist. Anything not on the list
 * falls back to the resource default, so `sort` can never reach Mongo raw.
 * Every sort carries an `_id` tiebreaker for stable pagination.
 */
export function resolveSort(sortMap, key, fallbackKey) {
  const chosen = (key && sortMap[key]) || sortMap[fallbackKey] || {};
  return { ...chosen, _id: -1 };
}

/**
 * Single entry point for every list endpoint: filter + whitelisted sort +
 * skip/limit + count, all executed in Mongo (§4).
 */
export async function paginate(
  collection,
  { filter = {}, sort = { _id: -1 }, page, pageSize, projection, collation } = {},
) {
  const paging = clampPaging({ page, pageSize });

  const cursor = collection
    .find(filter)
    .sort(sort)
    .skip(paging.skip)
    .limit(paging.pageSize);

  if (projection) cursor.project(projection);
  if (collation) cursor.collation(collation);

  const countOptions = collation ? { collation } : {};
  const [data, total] = await Promise.all([
    cursor.toArray(),
    collection.countDocuments(filter, countOptions),
  ]);

  return {
    data,
    meta: buildMeta({ page: paging.page, pageSize: paging.pageSize, total }),
  };
}

/**
 * Aggregation-pipeline variant for lists that need `$lookup` (course cards
 * carry their track and instructor). `$facet` keeps it to one round trip.
 */
export async function paginateAggregate(collection, pipeline, { page, pageSize } = {}) {
  const paging = clampPaging({ page, pageSize });

  const [result] = await collection
    .aggregate([
      ...pipeline,
      {
        $facet: {
          data: [{ $skip: paging.skip }, { $limit: paging.pageSize }],
          total: [{ $count: 'value' }],
        },
      },
    ])
    .toArray();

  const total = result?.total?.[0]?.value ?? 0;
  return {
    data: result?.data ?? [],
    meta: buildMeta({ page: paging.page, pageSize: paging.pageSize, total }),
  };
}

/** `dateFrom`/`dateTo` → a Mongo range clause, or undefined when both absent. */
export function dateRange(from, to) {
  if (!from && !to) return undefined;
  const range = {};
  if (from) range.$gte = new Date(from);
  if (to) {
    const end = new Date(to);
    end.setUTCHours(23, 59, 59, 999);
    range.$lte = end;
  }
  return range;
}
