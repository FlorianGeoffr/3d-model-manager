/**
 * Shared MakerWorld collections-sync orchestration (import-health branch
 * T5). Extracted out of the popup's old `handleSyncCollections` so BOTH the
 * popup (manual "Sync collections to app" button, `popup.js`) and the
 * background service worker (auto-sync on page visit, `background.js`)
 * drive the exact same flow instead of two copies drifting apart.
 *
 * `chrome.*` is never called here directly -- the impure seams are all
 * injected, so this module stays unit-testable with stubs (`test/
 * syncFlow.test.js`):
 *   - `exec(tabId, func, args)`: wraps `chrome.scripting.executeScript`,
 *     resolving to the injected function's return value. Used to read the
 *     page's `__NEXT_DATA__`/data route and to fetch each collection's
 *     items straight out of the page (the page's own origin carries the
 *     browser's cookies/`cf_clearance` a background-worker `fetch`
 *     couldn't).
 *   - `api`: an `api.js` client (`pushCollections`/`pushCollectionItems`).
 *   - `report(text, kind)`: status callback. The popup wires this to its
 *     status line; the background service worker wires it to `console.*`
 *     only (background failures are silent to the user -- see
 *     `background.js`).
 *
 * `syncCollections` resolves to `{collections, items, unreadable, partial}`
 * on success (including a run where some collections' items came up
 * unreadable from BOTH sources -- see `readCollectionItemsFromDataRoute`
 * and `readCollectionItems` below -- or came up SHORTER than the collection's
 * own known count even after both sources were tried, `partial`, F2
 * hardening) and REJECTS on a hard failure (page unreadable, no collections
 * found/readable, list push rejected) -- the rejection's `message` is the
 * same user-facing text `report` was just called with, so callers can
 * surface it verbatim without re-deriving it.
 */

import {
  buildItemsFetchPlan,
  extractFavoritesListFrom,
  extractHandle,
  findDesignListIn,
  hasFavoritesList,
  mapDesignHits,
} from "./collections.js";
import { hashToken } from "./courier.js";

// Matches the backend's own page size (`_SEARCH_PAGE_SIZE`,
// `backend/app/importers/makerworld.py`) so a page pulled in-browser lines
// up with how the app would page the same endpoint.
const ITEMS_PAGE_SIZE = 20;

/**
 * Executed IN THE COLLECTIONS PAGE (via the injected `exec`), not the
 * service worker or the popup -- `chrome.scripting` serializes this
 * function's source and re-evaluates it in the page's isolated world, so it
 * cannot close over anything from this module, only its own args and
 * globals the page provides (`document`, `location`, `fetch`).
 *
 * Reads the inline `__NEXT_DATA__` script tag AND -- when it carries a
 * `buildId` -- also fetches the page's own Next.js data route
 * (`/_next/data/<buildId><pathname>.json`) for a FRESH copy of the same
 * page's props. The inline snapshot goes stale on a client-side SPA
 * navigation (Next.js only embeds the FIRST server-rendered page's props;
 * navigating to `/collections` inside the app without a hard reload leaves
 * `__NEXT_DATA__.props.pageProps` as whatever page loaded first) -- live bug
 * report: the popup said "No collections found" while the user was looking
 * right at their collections, until a hard refresh. The data route always
 * reflects the CURRENT page, so `readCollectionsPage` below prefers it.
 * @returns {{nextData: unknown, routePageProps: unknown}} `nextData` is the
 *   parsed `__NEXT_DATA__` (or `null` if missing/malformed). `routePageProps`
 *   is the data route response's `pageProps`, or `null` on a missing
 *   `buildId`, fetch failure, non-ok response, or parse failure (silent
 *   fallback -- the caller falls back to `nextData` in that case).
 */
async function readCollectionsDataInPage() {
  let nextData;
  try {
    nextData = JSON.parse(document.getElementById("__NEXT_DATA__")?.textContent ?? "null");
  } catch {
    nextData = null;
  }

  let routePageProps = null;
  const buildId = nextData?.buildId;
  if (buildId) {
    try {
      const pathname = location.pathname.replace(/\/$/, "");
      const response = await fetch(`/_next/data/${buildId}${pathname}.json`, {
        credentials: "include",
      });
      if (response.ok) {
        const routeJson = await response.json();
        routePageProps = routeJson?.pageProps ?? null;
      }
    } catch {
      routePageProps = null;
    }
  }

  return { nextData, routePageProps };
}

/**
 * Executed IN THE COLLECTIONS PAGE (see `readCollectionsDataInPage` above)
 * -- same self-contained-function constraint applies. FALLBACK item source
 * (see `readCollectionItemsFromDataRoute` below for the PRIMARY one) --
 * kept because it's the one path that's confirmed to work end-to-end for
 * SOME accounts, even though a real sync on the reporting user's account
 * pushed 6 collections but zero items through it (handle extraction may
 * have failed, or this endpoint may just be uid-aggregate-only even from a
 * real signed-in browser).
 * @param {string} listId
 * @param {string} handle
 * @param {number[]} offsets
 * @returns {Promise<Array<unknown>>} one parsed JSON response per offset (or
 *   `null` for an offset whose fetch failed/didn't parse as JSON) -- fed to
 *   `mapDesignHits` below.
 */
async function fetchCollectionItemsInPage(listId, handle, offsets) {
  const pages = [];
  for (const offset of offsets) {
    try {
      const response = await fetch(
        "/api/v1/design-service/favorites/designs/" +
          listId +
          "?handle=@" +
          handle +
          "&limit=20&offset=" +
          offset,
        {
          credentials: "include",
          headers: { "x-bbl-client-type": "web", "x-bbl-app-source": "makerworld" },
        },
      );
      pages.push(await response.json());
    } catch {
      pages.push(null);
    }
  }
  return pages;
}

/**
 * FALLBACK: fetches one collection's items IN THE PAGE across every offset
 * planned for it via the `/api/v1` favorites-designs endpoint, and maps the
 * pages to push entries with `mapDesignHits`. Never throws -- a failed
 * injection or an in-browser fetch that comes back empty both just yield
 * `[]`, which the caller (`syncCollections`) treats as "no items readable"
 * unless the PRIMARY data-route source (below) already found something.
 */
async function readCollectionItems(tabId, listId, handle, offsets, exec) {
  let pages;
  try {
    pages = await exec(tabId, fetchCollectionItemsInPage, [listId, handle, offsets]);
  } catch {
    return [];
  }
  const items = [];
  for (const page of pages || []) {
    items.push(...mapDesignHits(page));
  }
  return items;
}

/**
 * Executed IN THE COLLECTIONS PAGE (see `readCollectionsDataInPage` above)
 * -- same self-contained-function constraint applies. Fetches ONE
 * collection's own SSR data route -- handle-free, unlike
 * `fetchCollectionItemsInPage` above, since the route URL only needs the
 * `buildId` and the collection's own pathname (`<collections-pathname>/
 * <listId>`), both already known to the caller.
 * @param {string} buildId
 * @param {string} collectionPathname e.g. `/en/@Terminalfoo/collections/18925823`
 * @returns {Promise<unknown>} the parsed data-route JSON (`{pageProps, ...}`),
 *   or `null` on a missing `buildId`, fetch failure, non-ok response, or
 *   parse failure.
 */
async function fetchCollectionDataRouteInPage(buildId, collectionPathname) {
  if (!buildId) {
    return null;
  }
  try {
    const response = await fetch(`/_next/data/${buildId}${collectionPathname}.json`, {
      credentials: "include",
    });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * PRIMARY item source (M10 Workstream, live-bug fix): reads one
 * collection's items straight off its own SSR data route instead of the
 * `/api/v1/design-service/favorites/designs/{listId}` endpoint
 * (`readCollectionItems` above, now the FALLBACK) -- LIVE EVIDENCE: a real
 * sync pushed 6 collections but ZERO items through that endpoint. The exact
 * `pageProps` field carrying the design list on this route wasn't captured
 * live, so `findDesignListIn` (`collections.js`) scans tolerantly; this
 * function logs which key matched via `report` (kind `null`, informational)
 * so a future drift in that field name is diagnosable instead of silently
 * falling back forever. Never throws -- a failed injection or a route with
 * no recognizable design array both just yield `found: false`.
 *
 * Returns `found` separately from `items` (F3 hardening) so the caller
 * (`syncCollections`) can tell "a trusted design list was located and it's
 * just empty" (`found: true, items: []` -- a genuinely-empty collection)
 * apart from "no recognizable design list at all" (`found: false, items: []`
 * -- falls back to `readCollectionItems`). Before this fix both cases looked
 * identical (`[]`) to the caller, so a genuinely-empty collection was
 * indistinguishable from a read failure and got needlessly routed through
 * the fallback and then flagged unreadable.
 * @returns {Promise<{items: import("./collections.js").CollectionItemPushEntry[], found: boolean}>}
 */
async function readCollectionItemsFromDataRoute(
  tabId,
  buildId,
  collectionPathname,
  entryTitle,
  exec,
  report,
) {
  let routeJson;
  try {
    routeJson = await exec(tabId, fetchCollectionDataRouteInPage, [buildId, collectionPathname]);
  } catch {
    return { items: [], found: false };
  }
  const found = findDesignListIn(routeJson?.pageProps);
  if (!found) {
    return { items: [], found: false };
  }
  report(`Matched items for "${entryTitle}" via pageProps.${found.key}.`, null);
  // Tolerant of a `name` field standing in for `title` (the deep-scan shape
  // check in `findDesignListIn` accepts either) -- `mapDesignHits` itself
  // only recognizes `title`, so normalize before reusing it.
  const normalized = found.designs.map((design) =>
    design && !design.title && design.name ? { ...design, title: design.name } : design,
  );
  return { items: mapDesignHits({ hits: normalized }), found: true };
}

/**
 * Best-effort pathname for the collections page itself, derived from the
 * tab's own URL (the same value `extractHandle` trusts as current/accurate
 * -- see its doc) -- used to build each collection's own data-route
 * pathname (`<this>/<listId>`) for `readCollectionItemsFromDataRoute`.
 * Trailing slash stripped to match `readCollectionsDataInPage`'s own
 * `location.pathname` normalization. `null` when `url` doesn't parse.
 * @param {string} url
 * @returns {string|null}
 */
function collectionsPathnameFrom(url) {
  try {
    const pathname = new URL(url).pathname;
    return pathname.replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * Reads the collections page's live data (via the injected `exec`) and
 * extracts its favorites list with the pure `extractFavoritesListFrom`,
 * preferring a FRESH read off the page's own Next.js data route over the
 * inline `__NEXT_DATA__` snapshot (which can go stale across a client-side
 * SPA navigation -- see `readCollectionsDataInPage`'s doc). The route is
 * trusted whenever it yields a `favoritesList` array AT ALL, even an EMPTY
 * one (an empty array is still a legitimate "you have zero collections"
 * answer FROM THE FRESH SOURCE); the inline snapshot is only consulted when
 * the route was unreachable or its shape didn't include a `favoritesList`
 * at all.
 *
 * Exported so callers that need to know "what's on the page right now"
 * WITHOUT running the full sync -- the background auto-sync's hash-throttle
 * check (`background.js`) -- can share the exact same read/extract logic
 * `syncCollections` uses, and hand the result to `syncCollections` via its
 * `page` option to avoid reading twice.
 * @param {{tabId: number, exec: (tabId: number, func: Function, args?: unknown[]) => Promise<unknown>}} opts
 * @returns {Promise<{nextData: unknown, entries: import("./collections.js").CollectionPushEntry[], found: boolean}|null>}
 *   `null` when the page itself couldn't be read (a hard failure -- the
 *   `exec` injection threw). `found` is `true` when a `favoritesList` array
 *   was located (route or inline), even if `entries` ends up empty (a
 *   genuinely-empty account); `false` when NEITHER source had a
 *   `favoritesList` at all (stale/malformed snapshot AND an unreachable
 *   route) -- `syncCollections` uses this to pick between "you have no
 *   collections" and "try a hard refresh" (see its doc).
 */
export async function readCollectionsPage({ tabId, exec }) {
  let page;
  try {
    page = await exec(tabId, readCollectionsDataInPage);
  } catch {
    return null;
  }
  const { nextData, routePageProps } = page ?? {};
  if (hasFavoritesList(routePageProps)) {
    return { nextData, entries: extractFavoritesListFrom(routePageProps), found: true };
  }
  if (hasFavoritesList(nextData)) {
    return { nextData, entries: extractFavoritesListFrom(nextData), found: true };
  }
  return { nextData, entries: [], found: false };
}

/**
 * SHA-256 hash (hex, via `courier.js`'s `hashToken`) of a `readCollectionsPage`
 * result's `entries` -- the payload the background auto-sync throttle
 * compares against `lastCollectionsHash` (`background.js`) to decide
 * whether anything actually changed since the last push.
 * @param {Array} entries
 * @returns {Promise<string>}
 */
export function hashCollectionsPayload(entries) {
  return hashToken(JSON.stringify(entries ?? []));
}

/**
 * True when `entries`' hash differs from `lastHash` -- mirrors `courier.js`'s
 * `shouldPush` semantics (same "hash the current value, compare to the last
 * pushed hash" shape) but for the collections payload instead of the
 * MakerWorld cookie.
 * @param {Array} entries
 * @param {string|null|undefined} lastHash
 * @returns {Promise<boolean>}
 */
export async function shouldPushCollections(entries, lastHash) {
  const hash = await hashCollectionsPayload(entries);
  return hash !== lastHash;
}

/**
 * True when a `syncCollections` result should have its throttle hash
 * persisted (`background.js`'s `lastCollectionsHash`) -- only on a fully-
 * clean run where every collection's items were BOTH readable AND complete.
 * Either kind of incomplete read must NOT advance the hash: an `unreadable`
 * collection (`unreadable.length > 0`) -- MakerWorld can serve a
 * collection's items empty transiently (same "empty isn't proof of empty"
 * caution as the cookie courier) -- or a `partial` one (F2 hardening,
 * `syncCollections`'s truncation handling: pushed SOME items, but fewer than
 * the collection's own known count even after the paged fallback was tried).
 * Persisting the hash on either would mean auto-sync never retries those
 * collections until the list itself changes. `result.partial` is optional in
 * the input shape (defaults to none) so callers/tests that predate F2 don't
 * need to thread an empty array through. Pulled out as its own pure function
 * so the persist decision is testable without a `chrome.*` stub.
 * @param {{unreadable: string[], partial?: string[]}} result
 * @returns {boolean}
 */
export function shouldPersistHash(result) {
  return result.unreadable.length === 0 && (result.partial?.length ?? 0) === 0;
}

/**
 * Runs the full collections sync: read the page, push the collection list,
 * then read+push each collection's items. See the module docstring for the
 * injected-seam contract and the resolve/reject shape.
 * @param {object} opts
 * @param {number} opts.tabId
 * @param {string} opts.url the tab's URL (used to derive the handle)
 * @param {(tabId: number, func: Function, args?: unknown[]) => Promise<unknown>} opts.exec
 * @param {{pushCollections: Function, pushCollectionItems: Function}} opts.api
 * @param {(text: string, kind: string|null) => void} opts.report
 * @param {{nextData: unknown, entries: Array, found: boolean}} [opts.page] a
 *   pre-fetched `readCollectionsPage` result -- when supplied,
 *   `syncCollections` skips its own page read and uses this instead (the
 *   background auto-sync throttle already read the page once to compute a
 *   hash; there's no need to read it again here).
 * @returns {Promise<{collections: number, items: number, unreadable: string[], partial: string[]}>}
 */
export async function syncCollections({ tabId, url, exec, api, report, page }) {
  report("Reading collections…", null);

  const resolvedPage = page ?? (await readCollectionsPage({ tabId, exec }));
  if (!resolvedPage) {
    const message = "Couldn't read this page.";
    report(message, "error");
    throw new Error(message);
  }

  const { nextData, entries, found } = resolvedPage;
  if (entries.length === 0) {
    // Two genuinely different situations, told apart by `found`
    // (`readCollectionsPage`'s doc): a `favoritesList` array was located
    // (route or inline) and it's just empty -- vs. NEITHER source had one
    // at all, which is the stale-snapshot/unreadable-route failure mode
    // from the live bug report ("No collections found" while the user was
    // looking right at their collections).
    const message = found
      ? "No collections in your MakerWorld account yet."
      : "Couldn't read your collections from this page — try a hard refresh (Ctrl+Shift+R) and click again.";
    report(message, "error");
    throw new Error(message);
  }

  report("Syncing…", null);
  const listResult = await api.pushCollections("makerworld", entries);
  if (!listResult.ok) {
    const message = listResult.error || "Something went wrong.";
    report(message, "error");
    throw new Error(message);
  }

  const handle = extractHandle(nextData, url);
  const buildId = nextData?.buildId ?? null;
  const collectionsPathname = collectionsPathnameFrom(url);

  const offsetsByList = new Map();
  for (const { listId, offset } of buildItemsFetchPlan(entries, ITEMS_PAGE_SIZE)) {
    if (!offsetsByList.has(listId)) {
      offsetsByList.set(listId, []);
    }
    offsetsByList.get(listId).push(offset);
  }

  let totalItems = 0;
  const unreadableTitles = [];
  const partialTitles = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    report(`Reading items for "${entry.title}" (${i + 1}/${entries.length})…`, null);

    // PRIMARY: the collection's own SSR data route, handle-free -- see
    // `readCollectionItemsFromDataRoute`'s doc for why this is now tried
    // first (a real sync pushed 6 collections but zero items through the
    // FALLBACK below).
    let primary = { items: [], found: false };
    if (buildId && collectionsPathname) {
      primary = await readCollectionItemsFromDataRoute(
        tabId,
        buildId,
        `${collectionsPathname}/${entry.list_id}`,
        entry.title,
        exec,
        report,
      );
    }

    if (primary.found && primary.items.length === 0) {
      // F3: a TRUSTED design list was located on the data route and it's
      // just empty -- a genuinely-empty collection, told apart from "no
      // recognizable design list at all" by `primary.found`. Push nothing,
      // don't treat it as unreadable, and don't even try the fallback (there
      // is nothing to recover -- the primary source already answered
      // definitively).
      continue;
    }

    let items = primary.items;
    // Needs the paged `/api/v1` fallback when either (a) the primary source
    // found nothing at all (`found: false`, or unreachable/no buildId), or
    // (b) it found SOME items but fewer than the collection's own known
    // `count` (F2) -- the SSR data route can silently truncate a large
    // collection's item array rather than paging it, so a short primary
    // read isn't proof the collection actually has that few items. Only
    // attempted when a handle is available (the fallback endpoint needs
    // one).
    const primaryCount = items.length;
    const needsFallback =
      Boolean(handle) && (primaryCount === 0 || (entry.count != null && primaryCount < entry.count));
    if (needsFallback) {
      const fallbackItems = await readCollectionItems(
        tabId,
        entry.list_id,
        handle,
        offsetsByList.get(entry.list_id) || [0],
        exec,
      );
      // Only adopt the fallback's items when it did BETTER than the primary
      // -- a worse/equal fallback read (e.g. the same truncation, or a
      // transient empty response) must not throw away a longer primary
      // result.
      if (fallbackItems.length > primaryCount) {
        items = fallbackItems;
      }
    }

    if (items.length === 0) {
      // Both sources came up empty -- never push an empty membership set
      // (the backend's own fallback treats absence as "no data", safer
      // than a wrong empty set overwriting real cached items).
      unreadableTitles.push(entry.title);
      continue;
    }
    const itemsResult = await api.pushCollectionItems("makerworld", entry.list_id, items);
    if (itemsResult.ok) {
      totalItems += items.length;
      if (entry.count != null && items.length < entry.count) {
        // F2: pushed what we have, but it's still short of the collection's
        // own known count even after the fallback was tried -- flag it as
        // `partial` rather than silently reporting success with wrong
        // (incomplete) data. Like `unreadable`, this suppresses the
        // background auto-sync's hash persist (`shouldPersistHash`) so the
        // next visit retries this collection instead of treating the short
        // read as done.
        partialTitles.push(entry.title);
      }
    } else {
      unreadableTitles.push(entry.title);
    }
  }

  const unreadableSuffix =
    unreadableTitles.length > 0
      ? `; ${unreadableTitles.length} collection${unreadableTitles.length === 1 ? "" : "s"} unreadable`
      : "";
  const partialSuffix =
    partialTitles.length > 0
      ? `; ${partialTitles.length} collection${partialTitles.length === 1 ? "" : "s"} partial`
      : "";
  report(
    `Synced ${entries.length} collections (${totalItems} items${unreadableSuffix}${partialSuffix}).`,
    "ok",
  );
  return {
    collections: entries.length,
    items: totalItems,
    unreadable: unreadableTitles,
    partial: partialTitles,
  };
}
