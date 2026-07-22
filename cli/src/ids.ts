// Short-id display + prefix resolution. Pure — unit-tested in __tests__.
//
// Ids are uuidv7, so the leading hex chars are a timestamp: rows created
// close together share long prefixes. Listings therefore print the SHORTEST
// prefix (minimum 8 chars) that is unique within the listed set, and any
// unambiguous prefix is accepted wherever an id is expected.

export const MIN_PREFIX = 8;

/** Shortest prefix of `id` (≥ MIN_PREFIX chars) unique among `allIds`. */
export function shortId(id: string, allIds: readonly string[]): string {
  for (let len = MIN_PREFIX; len < id.length; len++) {
    const prefix = id.slice(0, len);
    if (!allIds.some((other) => other !== id && other.startsWith(prefix))) return prefix;
  }
  return id;
}

export type PrefixMatch<T> =
  | { kind: "one"; row: T }
  | { kind: "none" }
  | { kind: "many"; rows: T[] };

/**
 * Resolve a user-supplied id or prefix against `rows`. An exact full-id match
 * wins outright (a full uuid is never "ambiguous" with rows that merely share
 * its prefix); otherwise every row whose id starts with the prefix matches.
 * Matching is case-insensitive — uuids are stored lowercase.
 */
export function resolveByPrefix<T extends { id: string }>(
  rows: readonly T[],
  ref: string,
): PrefixMatch<T> {
  const needle = ref.toLowerCase();
  const exact = rows.find((row) => row.id === needle);
  if (exact) return { kind: "one", row: exact };
  const matches = rows.filter((row) => row.id.startsWith(needle));
  if (matches.length === 1) return { kind: "one", row: matches[0] };
  if (matches.length === 0) return { kind: "none" };
  return { kind: "many", rows: matches };
}
