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
 * unreadable from EVERY source tried -- see `readCollectionItemsFromDataRoute`
 * and `readCollectionItems` below -- or came up SHORTER than the collection's
 * own known count even after every source was tried, `partial`, F2
 * hardening) and REJECTS on a hard failure (page unreadable, no collections
 * found/readable, list push rejected) -- the rejection's `message` is the
 * same user-facing text `report` was just called with, so callers can
 * surface it verbatim without re-deriving it.
 *
 * `syncCollectionDetail` (M11) is a SEPARATE, guaranteed-correct flow for
 * the collection detail page the user is actually looking at -- see its own
 * doc below.
 */

import {
  buildItemsFetchPlan,
  collectionDetailPathnameFrom,
  extractFavoritesListFrom,
  extractHandle,
  findCollectionTitleIn,
  findDesignListIn,
  hasFavoritesList,
  mapDesignHits,
  matchCollectionLinks,
  parseCollectionDetailUrl,
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
 * reflects the CURRENT page, so `readCollectionsPage` (and
 * `readCollectionDetailPage`, M11) below prefer it. This function is
 * pathname-agnostic (reads `location.pathname`, whatever page it's injected
 * into) -- reused verbatim for the collection DETAIL page read, not just the
 * collections LIST page.
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
 * Executed IN THE COLLECTIONS PAGE (see `readCollectionsDataInPage`'s doc
 * for the self-contained-function constraint). Collects every `a[href]` on
 * the page whose BROWSER-RESOLVED absolute href is same-origin and whose
 * pathname loosely looks like it MIGHT be a collection link (contains
 * `/collection` or `/collections`) -- a cheap, coarse pre-filter only; the
 * PRECISE "does this pathname actually match the collection-detail shape
 * for one of OUR synced list ids" matching happens back in
 * `matchCollectionLinks` (`collections.js`), a pure function that's unit-
 * tested directly instead of only reachable through a DOM. Kept deliberately
 * dumb (no list-id awareness, no shape validation) so this in-page function
 * stays trivially self-contained.
 * @returns {string[]} deduped pathnames (query strings/hashes dropped, same
 *   as `location.pathname`).
 */
function collectCollectionAnchorPathnamesInPage() {
  const seen = new Set();
  const pathnames = [];
  const anchors = document.querySelectorAll("a[href]");
  for (const anchor of anchors) {
    const href = anchor.href; // browser-resolved, always absolute
    if (!href) {
      continue;
    }
    let url;
    try {
      url = new URL(href);
    } catch {
      continue;
    }
    if (url.origin !== location.origin) {
      continue; // same-origin only
    }
    if (!/\/collections?\//i.test(url.pathname)) {
      continue;
    }
    if (!seen.has(url.pathname)) {
      seen.add(url.pathname);
      pathnames.push(url.pathname);
    }
  }
  return pathnames;
}

/**
 * Executed IN THE COLLECTIONS PAGE (see `readCollectionsDataInPage` above)
 * -- same self-contained-function constraint applies. FALLBACK item source
 * (see `readCollectionItemsFromDataRoute` below for the PRIMARY ones) --
 * kept because it's the one path that's confirmed to work end-to-end for
 * SOME accounts, even though a real sync on the reporting user's account
 * pushed 6 collections but zero items through it (handle extraction may
 * have failed, or this endpoint may just be uid-aggregate-only even from a
 * real signed-in browser -- CONFIRMED TWICE in-browser, M11: this endpoint
 * serves only the uid aggregate, everywhere, so it is genuinely a
 * last-resort fallback now, not a "maybe it works" one).
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
 * unless a PRIMARY data-route source (below) already found something.
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
 * collection's own SSR data route for an already-known pathname (either an
 * anchor-derived real link or the ground-truth `collectionDetailPathnameFrom`
 * construction -- both handle-free, unlike `fetchCollectionItemsInPage`
 * above).
 * @param {string} buildId
 * @param {string} collectionPathname e.g. `/en/collections/18925823-esp32`
 * @returns {Promise<unknown>} the parsed data-route JSON (`{pageProps, ...}`),
 *   or `null` on a fetch failure, non-ok response, or parse failure.
 */
async function fetchCollectionDataRouteInPage(buildId, collectionPathname) {
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
 * PRIMARY item source (M10/M11): reads one collection's items straight off
 * a candidate SSR data-route pathname instead of the
 * `/api/v1/design-service/favorites/designs/{listId}` endpoint
 * (`readCollectionItems` above, now the LAST-RESORT fallback -- CONFIRMED
 * uid-aggregate-only, M11). The exact `pageProps` field carrying the design
 * list on this route wasn't captured live, so `findDesignListIn`
 * (`collections.js`) scans tolerantly; this function logs which key matched
 * via `report` (kind `null`, informational) so a future drift in that field
 * name is diagnosable instead of silently falling back forever. Never
 * throws -- a failed injection or a route with no recognizable design array
 * both just yield `found: false`.
 *
 * Returns `found` separately from `items` (F3 hardening) so the caller
 * (`syncCollections`) can tell "a trusted design list was located and it's
 * just empty" (`found: true, items: []` -- a genuinely-empty collection)
 * apart from "no recognizable design list at all" (`found: false, items: []`
 * -- try the next candidate pathname, then falls back to
 * `readCollectionItems`).
 *
 * Also returns a `diagnostic` string (M11) describing THIS ONE source's
 * outcome for the unreadable-collection diagnostic (`describeUnreadableCollection`
 * below) -- top-level `pageProps` KEY NAMES only, never values, so a pasted
 * diagnostic line can never leak a user's collection contents.
 * @returns {Promise<{items: import("./collections.js").CollectionItemPushEntry[], found: boolean, diagnostic: string}>}
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
    return { items: [], found: false, diagnostic: "route unreachable" };
  }
  if (!routeJson) {
    return { items: [], found: false, diagnostic: "route 404 or unavailable" };
  }
  const found = findDesignListIn(routeJson?.pageProps);
  if (!found) {
    const pageProps = routeJson?.pageProps;
    const keys =
      pageProps && typeof pageProps === "object" ? Object.keys(pageProps).join(", ") || "(none)" : "(not an object)";
    return {
      items: [],
      found: false,
      diagnostic: `route ok but no design array (pageProps keys: ${keys})`,
    };
  }
  report(`Matched items for "${entryTitle}" via pageProps.${found.key}.`, null);
  // Tolerant of a `name` field standing in for `title` (the deep-scan shape
  // check in `findDesignListIn` accepts either) -- `mapDesignHits` itself
  // only recognizes `title`, so normalize before reusing it.
  const normalized = found.designs.map((design) =>
    design && !design.title && design.name ? { ...design, title: design.name } : design,
  );
  return {
    items: mapDesignHits({ hits: normalized }),
    found: true,
    diagnostic: `route ok, matched pageProps.${found.key}`,
  };
}

/**
 * Composes the ONE diagnostic line surfaced for the FIRST collection that
 * stays unreadable from every source tried (M11 -- live bug report:
 * "Synced 7 collections (0 items; 7 collections unreadable)" with no way to
 * tell WHY from the popup's summary alone). Exported so this formatting is
 * unit-testable without driving the whole `syncCollections` flow. Never
 * includes field VALUES -- `attempts[].diagnostic` strings
 * (`readCollectionItemsFromDataRoute` above) are already scrubbed to key
 * names only, and this function adds nothing but pathnames (already public
 * -- they're URLs) and counts.
 * @param {string} title
 * @param {{anchorPathname: string|null, attempts: Array<{label: string, pathname: string, diagnostic: string}>, fallback: string}} info
 * @returns {string}
 */
export function describeUnreadableCollection(title, { anchorPathname, attempts, fallback }) {
  const attemptText = (attempts || [])
    .map((attempt) => `${attempt.label} (${attempt.pathname}): ${attempt.diagnostic}`)
    .join("; ");
  const anchorText = anchorPathname ? `found (${anchorPathname})` : "not found";
  return (
    `Diagnostic for "${title}" -- anchor link ${anchorText}` +
    (attemptText ? `; ${attemptText}` : "") +
    `; fallback: ${fallback}.`
  );
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
 * the collection's own known count even after the fallback was tried).
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
 *
 * Item source order per collection (M11, ground-truth-informed): (1) the
 * ANCHOR-derived pathname (`matchCollectionLinks` on every `a[href]`
 * collected from the page ONCE up front, `collectCollectionAnchorPathnamesInPage`)
 * when a real link to this collection was found on the page -- an actual
 * link can never be wrong about its own shape; (2) the ground-truth
 * CONSTRUCTED pathname (`collectionDetailPathnameFrom`,
 * `/{locale}/collections/{listId}[-slug]`) built straight from the entry's
 * own pushed data -- costs one fetch, and covers every collection even when
 * no anchor to it exists on the current page; (3) the `/api/v1` paged
 * fallback (confirmed uid-aggregate-only, M11 -- genuinely last-resort now).
 * @param {object} opts
 * @param {number} opts.tabId
 * @param {string} opts.url the tab's URL (used to derive the handle and the
 *   constructed pathname's locale prefix)
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

  // Collect every anchor on the page ONCE (not per collection) and match it
  // against the pushed list ids -- see `collectCollectionAnchorPathnamesInPage`
  // and `matchCollectionLinks` docs. Only worth doing when there's a
  // `buildId` to build a data route from (same gating as the constructed
  // pathname below); never throws -- an unreadable page here just means no
  // anchor pathnames were found, falling straight through to the
  // constructed candidate.
  let anchorPathnames = new Map();
  if (buildId) {
    let anchorHrefs = [];
    try {
      anchorHrefs = (await exec(tabId, collectCollectionAnchorPathnamesInPage)) || [];
    } catch {
      anchorHrefs = [];
    }
    anchorPathnames = matchCollectionLinks(
      anchorHrefs,
      entries.map((entry) => entry.list_id),
    );
  }

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
  let firstUnreadableDiagnostic = null;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    report(`Reading items for "${entry.title}" (${i + 1}/${entries.length})…`, null);

    const anchorPathname = anchorPathnames.get(entry.list_id) || null;
    const constructedPathname = collectionDetailPathnameFrom(url, entry.list_id, entry.slug);

    // PRIMARY sources, tried in order until one returns a TRUSTED result
    // (`found: true`, even if its items are empty -- see
    // `readCollectionItemsFromDataRoute`'s F3 doc): the anchor-derived real
    // link first (when one was found), then the ground-truth construction.
    const primaryAttempts = [];
    let primary = { items: [], found: false };
    if (buildId) {
      const candidates = anchorPathname
        ? [
            { label: "anchor", pathname: anchorPathname },
            { label: "constructed", pathname: constructedPathname },
          ]
        : [{ label: "constructed", pathname: constructedPathname }];
      for (const candidate of candidates) {
        const attempt = await readCollectionItemsFromDataRoute(
          tabId,
          buildId,
          candidate.pathname,
          entry.title,
          exec,
          report,
        );
        primaryAttempts.push({ ...candidate, diagnostic: attempt.diagnostic });
        if (attempt.found) {
          primary = attempt;
          break;
        }
      }
    }

    if (primary.found && primary.items.length === 0) {
      // F3: a TRUSTED design list was located on a data route and it's
      // just empty -- a genuinely-empty collection, told apart from "no
      // recognizable design list at all" by `primary.found`. Push nothing,
      // don't treat it as unreadable, and don't even try the fallback (there
      // is nothing to recover -- the primary source already answered
      // definitively).
      continue;
    }

    let items = primary.items;
    // Needs the paged `/api/v1` fallback when either (a) no primary source
    // found anything at all (`found: false` on every candidate, or no
    // buildId), or (b) one found SOME items but fewer than the collection's
    // own known `count` (F2) -- an SSR data route can silently truncate a
    // large collection's item array rather than paging it, so a short
    // primary read isn't proof the collection actually has that few items.
    // Only attempted when a handle is available (the fallback endpoint needs
    // one).
    const primaryCount = items.length;
    const needsFallback =
      Boolean(handle) && (primaryCount === 0 || (entry.count != null && primaryCount < entry.count));
    let fallbackDiagnostic = handle ? null : "skipped (no handle)";
    if (needsFallback) {
      const fallbackItems = await readCollectionItems(
        tabId,
        entry.list_id,
        handle,
        offsetsByList.get(entry.list_id) || [0],
        exec,
      );
      fallbackDiagnostic = `${fallbackItems.length} item${fallbackItems.length === 1 ? "" : "s"}`;
      // Only adopt the fallback's items when it did BETTER than the primary
      // -- a worse/equal fallback read (e.g. the same truncation, or a
      // transient empty response) must not throw away a longer primary
      // result.
      if (fallbackItems.length > primaryCount) {
        items = fallbackItems;
      }
    }

    if (items.length === 0) {
      // Every source came up empty -- never push an empty membership set
      // (the backend's own fallback treats absence as "no data", safer
      // than a wrong empty set overwriting real cached items).
      unreadableTitles.push(entry.title);
      if (!firstUnreadableDiagnostic) {
        firstUnreadableDiagnostic = describeUnreadableCollection(entry.title, {
          anchorPathname,
          attempts: primaryAttempts,
          fallback: fallbackDiagnostic ?? "not attempted",
        });
        console.error(`[collections sync] ${firstUnreadableDiagnostic}`);
      }
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
  // The diagnostic (M11) is APPENDED to the summary rather than reported on
  // its own -- the popup's status line only ever shows the LAST `report`
  // call's text, so a mid-loop-only diagnostic would be overwritten by the
  // next collection's progress line before the user ever saw it.
  const diagnosticSuffix = firstUnreadableDiagnostic ? ` ${firstUnreadableDiagnostic}` : "";
  report(
    `Synced ${entries.length} collections (${totalItems} items${unreadableSuffix}${partialSuffix}).${diagnosticSuffix}`,
    "ok",
  );
  return {
    collections: entries.length,
    items: totalItems,
    unreadable: unreadableTitles,
    partial: partialTitles,
  };
}

/**
 * Reads a MakerWorld collection DETAIL page's live data (M11) -- the
 * guaranteed-correct item source: the user is LOOKING AT the collection's
 * own items right now, so there's no route-guessing or anchor-hunting
 * involved at all, unlike `syncCollections`'s bulk item discovery. Reuses
 * `readCollectionsDataInPage` (pathname-agnostic -- reads whatever page it's
 * injected into) for the actual read, then the SAME tolerant
 * `findDesignListIn` discovery `syncCollections` uses for the items, plus
 * `findCollectionTitleIn` (`collections.js`) for the collection's own title
 * (best-effort -- see its doc; `null` when not derivable).
 * @param {{tabId: number, url: string, exec: (tabId: number, func: Function, args?: unknown[]) => Promise<unknown>}} opts
 * @returns {Promise<{parsed: {id: string, slug: string|null}, pageProps: unknown, items: import("./collections.js").CollectionItemPushEntry[], title: string|null, found: boolean}|null>}
 *   `null` when `url` isn't a collection detail page at all, or the page
 *   itself couldn't be read (the `exec` injection threw). `found` is `true`
 *   when a design list was located (even an empty, genuinely-empty one);
 *   `false` when nothing recognizable was found -- `items` is `[]` either
 *   way in that case.
 */
export async function readCollectionDetailPage({ tabId, url, exec }) {
  const parsed = parseCollectionDetailUrl(url);
  if (!parsed) {
    return null;
  }

  let page;
  try {
    page = await exec(tabId, readCollectionsDataInPage);
  } catch {
    return null;
  }
  const { nextData, routePageProps } = page ?? {};
  const pageProps = routePageProps ?? nextData?.props?.pageProps ?? null;

  const found = findDesignListIn(pageProps);
  if (!found) {
    return { parsed, pageProps, items: [], title: null, found: false };
  }
  const normalized = found.designs.map((design) =>
    design && !design.title && design.name ? { ...design, title: design.name } : design,
  );
  const items = mapDesignHits({ hits: normalized });
  const title = findCollectionTitleIn(pageProps, parsed.id);
  return { parsed, pageProps, items, title, found: true };
}

/**
 * SHA-256 hash of a `readCollectionDetailPage` result's item ids (M11) --
 * the payload the background auto-sync throttle compares against
 * `lastCollectionItemsHash` (`background.js`/`config.js`) to decide whether
 * a given collection's membership actually changed since it was last
 * pushed. Hashes just the ids (not full item objects) since a design's
 * title/author/thumbnail changing without a membership change isn't
 * something this extension needs to re-sync for.
 * @param {import("./collections.js").CollectionItemPushEntry[]} items
 * @returns {Promise<string>}
 */
export function hashCollectionItemsPayload(items) {
  return hashToken(JSON.stringify((items || []).map((item) => item.external_id)));
}

// `config.js`'s `lastCollectionItemsHash` is an ARRAY of `{listId, hash}`
// pairs, oldest-first -- NOT a plain object keyed by listId. MakerWorld list
// ids are canonical-numeric-looking strings (e.g. `"18925823"`), and every
// JS engine silently reorders a plain object's INTEGER-like keys to
// ascending numeric order regardless of insertion order -- which would
// silently break "prune to the last 50 by recency" (`upsertCollectionItemsHash`
// below) the same way it would for any object keyed by an id like this.
const DEFAULT_MAX_COLLECTION_ITEM_HASHES = 50;

/**
 * Looks up `listId`'s last-pushed items hash within `entries`
 * (`config.js`'s `lastCollectionItemsHash` array shape -- see the doc
 * comment above `DEFAULT_MAX_COLLECTION_ITEM_HASHES`).
 * @param {Array<{listId: string, hash: string}>|null|undefined} entries
 * @param {string} listId
 * @returns {string|null}
 */
export function findLastCollectionItemsHash(entries, listId) {
  const match = (entries || []).find((entry) => entry && entry.listId === listId);
  return match ? match.hash : null;
}

/**
 * Returns a NEW array with `listId`'s hash upserted at the END (most
 * recently synced), pruned to the last `limit` entries -- the
 * `lastCollectionItemsHash` throttle map's update step
 * (`background.js`'s detail-page auto-sync). Pure -- doesn't mutate
 * `entries`.
 * @param {Array<{listId: string, hash: string}>|null|undefined} entries
 * @param {string} listId
 * @param {string} hash
 * @param {number} [limit]
 * @returns {Array<{listId: string, hash: string}>}
 */
export function upsertCollectionItemsHash(entries, listId, hash, limit = DEFAULT_MAX_COLLECTION_ITEM_HASHES) {
  const withoutListId = (entries || []).filter((entry) => entry && entry.listId !== listId);
  withoutListId.push({ listId, hash });
  return withoutListId.slice(-limit);
}

/**
 * True when `items`' id hash differs from the last-pushed hash recorded for
 * `listId` in `entries` -- mirrors `shouldPushCollections`'s shape, scoped
 * to one collection's items instead of the whole collections list.
 * @param {import("./collections.js").CollectionItemPushEntry[]} items
 * @param {Array<{listId: string, hash: string}>|null|undefined} entries
 * @param {string} listId
 * @returns {Promise<boolean>}
 */
export async function shouldPushCollectionItems(items, entries, listId) {
  const hash = await hashCollectionItemsPayload(items);
  return hash !== findLastCollectionItemsHash(entries, listId);
}

/**
 * Syncs a SINGLE collection straight from its own detail page (M11) --
 * a guaranteed-correct fallback/complement to `syncCollections`'s bulk
 * discovery: the user is looking right at this collection's items, so
 * there's no route-guessing involved. Pushes an upsert-shaped collections
 * entry (`pushCollections`) ONLY when a title was derivable
 * (`findCollectionTitleIn`, best-effort, unverified field names -- see its
 * doc); when it isn't, this pushes ITEMS ONLY, keyed by the id from the URL
 * (a collection push isn't required for `pushCollectionItems` to accept
 * items for that id -- see `backend/app/api/ext.py`). Also pushes nothing
 * for a genuinely-empty collection (`items.length === 0`) -- same "never
 * push an empty membership set" caution as `syncCollections`.
 * @param {object} opts
 * @param {number} opts.tabId
 * @param {string} opts.url the tab's URL -- must be a collection detail page
 * @param {(tabId: number, func: Function, args?: unknown[]) => Promise<unknown>} opts.exec
 * @param {{pushCollections: Function, pushCollectionItems: Function}} opts.api
 * @param {(text: string, kind: string|null) => void} opts.report
 * @param {Awaited<ReturnType<typeof readCollectionDetailPage>>} [opts.page] a
 *   pre-fetched `readCollectionDetailPage` result -- when supplied, skips
 *   the module's own page read (the background auto-sync throttle already
 *   read the page once to compute a hash).
 * @returns {Promise<{listId: string, title: string|null, items: number}>}
 */
export async function syncCollectionDetail({ tabId, url, exec, api, report, page }) {
  report("Reading this collection…", null);

  const resolvedPage = page ?? (await readCollectionDetailPage({ tabId, url, exec }));
  if (!resolvedPage) {
    const message = "This isn't a collection page.";
    report(message, "error");
    throw new Error(message);
  }
  if (!resolvedPage.found) {
    const message = "Couldn't read this collection's items from the page.";
    report(message, "error");
    throw new Error(message);
  }

  const { parsed, items, title } = resolvedPage;

  if (title) {
    const entry = {
      list_id: parsed.id,
      title,
      slug: parsed.slug,
      count: items.length,
      is_default: false,
    };
    const listResult = await api.pushCollections("makerworld", [entry]);
    if (!listResult.ok) {
      const message = listResult.error || "Something went wrong.";
      report(message, "error");
      throw new Error(message);
    }
  }

  if (items.length > 0) {
    const itemsResult = await api.pushCollectionItems("makerworld", parsed.id, items);
    if (!itemsResult.ok) {
      const message = itemsResult.error || "Something went wrong.";
      report(message, "error");
      throw new Error(message);
    }
  }

  const label = title || parsed.id;
  report(`Synced "${label}": ${items.length} item${items.length === 1 ? "" : "s"}.`, "ok");
  return { listId: parsed.id, title: title || null, items: items.length };
}
