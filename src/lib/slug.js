export function slugify(input) {
  return String(input)
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Escape a user string before it goes anywhere near a `$regex`. */
export function escapeRegex(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Prefix match for the admin people search (§4). Anchoring keeps the scan
 * bounded; the `i` flag is required because MongoDB applies collation to
 * comparisons but *not* to `$regex`, so a collation-only match would still be
 * case-sensitive.
 */
export function anchoredRegex(term) {
  return new RegExp(`^${escapeRegex(term.trim())}`, 'i');
}

/**
 * Finds a slug that isn't taken yet, appending -2, -3, … on collision.
 * `excludeId` lets an update keep its own slug.
 */
export async function uniqueSlug(collection, base, excludeId = null) {
  const root = slugify(base) || 'item';
  let candidate = root;
  let n = 1;

  for (;;) {
    const filter = { slug: candidate };
    if (excludeId) filter._id = { $ne: excludeId };
    const clash = await collection.findOne(filter, { projection: { _id: 1 } });
    if (!clash) return candidate;
    n += 1;
    candidate = `${root}-${n}`;
  }
}
