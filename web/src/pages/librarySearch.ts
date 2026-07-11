/**
 * The library route's URL contract (collection provenance, Task 2). A
 * model's provenance badge and its "More from <collection>" strip both link
 * to `/?collection=<id>` to hand the gallery straight to that followed
 * collection's models. Kept in its own module (no React export) for the same
 * reason as `viewerWindowSearch.ts` -- `validateSearch` has to serve as the
 * route's option AND be importable by the page, without tripping the
 * `react(only-export-components)` fast-refresh lint rule.
 */
export interface LibrarySearch {
  collection?: number;
}

/** TanStack's default search parser runs `JSON.parse` on each value, so a
 * numeric `?collection=5` already arrives as the NUMBER 5 (see
 * `viewerWindowSearch.ts`'s comment for the mirror-image case, where a
 * numeric-looking param needs coercing back to a string). Here the shoe's on
 * the other foot: anything that ISN'T already a number -- a hand-edited link,
 * a non-numeric string, an object -- must not leak through as a bogus filter,
 * so it drops to undefined instead of being trusted. */
export function parseLibrarySearch(search: Record<string, unknown>): LibrarySearch {
  const value = search.collection;
  return { collection: typeof value === "number" ? value : undefined };
}
