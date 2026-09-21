/**
 * The library route's URL contract (collection provenance, Task 2; category
 * + folder-path, R13b). A model's provenance badge and its "More from
 * <collection>" strip both link to `/?collection=<id>` to hand the gallery
 * straight to that followed collection's models; the sidebar's Categories
 * list links to `/?category=<id>` the same way. `path` is the Folders view's
 * current directory (empty/undefined at the root). Kept in its own module
 * (no React export) for the same reason as `viewerWindowSearch.ts` --
 * `validateSearch` has to serve as the route's option AND be importable by
 * the page, without tripping the `react(only-export-components)` fast-refresh
 * lint rule.
 */
export interface LibrarySearch {
  collection?: number;
  category?: number;
  project?: number;
  print_status?: string;
  path?: string;
}

/** TanStack's default search parser runs `JSON.parse` on each value, so a
 * numeric `?collection=5` already arrives as the NUMBER 5 (see
 * `viewerWindowSearch.ts`'s comment for the mirror-image case, where a
 * numeric-looking param needs coercing back to a string). Here the shoe's on
 * the other foot: anything that ISN'T already a number -- a hand-edited link,
 * a non-numeric string, an object -- must not leak through as a bogus filter,
 * so it drops to undefined instead of being trusted. `path` is expected to
 * already be a plain string (folder names, not JSON-shaped), so anything else
 * drops the same way. */
export function parseLibrarySearch(search: Record<string, unknown>): LibrarySearch {
  const collection = search.collection;
  const category = search.category;
  const project = search.project;
  const print_status = search.print_status;
  const path = search.path;
  return {
    collection: typeof collection === "number" ? collection : undefined,
    category: typeof category === "number" ? category : undefined,
    project: typeof project === "number" ? project : undefined,
    print_status: typeof print_status === "string" ? print_status : undefined,
    path: typeof path === "string" ? path : undefined,
  };
}
