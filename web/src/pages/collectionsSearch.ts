/**
 * The `/collections` route's URL contract (R7 T2): which of the page's three
 * tabs is active. Kept in its own module (no React export) for the same
 * reason as `librarySearch.ts`/`viewerWindowSearch.ts` -- `validateSearch`
 * has to serve as the route's option AND be importable by the page, without
 * tripping the `react(only-export-components)` fast-refresh lint rule.
 */
export type CollectionsTab = "review" | "collections" | "imports";

const COLLECTIONS_TABS: readonly CollectionsTab[] = ["review", "collections", "imports"];

export interface CollectionsSearch {
  tab?: CollectionsTab;
}

function isCollectionsTab(value: unknown): value is CollectionsTab {
  return typeof value === "string" && (COLLECTIONS_TABS as readonly string[]).includes(value);
}

/** An absent or unrecognized `?tab=` (hand-edited link, stale bookmark)
 * drops to `undefined` rather than being trusted -- the page then applies
 * its own default (review with pending items, else collections). */
export function parseCollectionsSearch(search: Record<string, unknown>): CollectionsSearch {
  return { tab: isCollectionsTab(search.tab) ? search.tab : undefined };
}
