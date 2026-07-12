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
 *     page's `__NEXT_DATA__` and to fetch each collection's items straight
 *     out of the page (the page's own origin carries the browser's
 *     cookies/`cf_clearance` a background-worker `fetch` couldn't).
 *   - `api`: an `api.js` client (`pushCollections`/`pushCollectionItems`).
 *   - `report(text, kind)`: status callback. The popup wires this to its
 *     status line; the background service worker wires it to `console.*`
 *     only (background failures are silent to the user -- see
 *     `background.js`).
 *
 * `syncCollections` resolves to `{collections, items, unreadable}` on
 * success (including the "list pushed, couldn't read a handle" partial-
 * success case -- same as the popup's prior behavior) and REJECTS on a hard
 * failure (page unreadable, no collections found, list push rejected) --
 * the rejection's `message` is the same user-facing text `report` was just
 * called with, so callers can surface it verbatim without re-deriving it.
 */

import {
  buildItemsFetchPlan,
  extractFavoritesList,
  extractHandle,
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
 * globals the page provides (`document`).
 * @returns {unknown} parsed `__NEXT_DATA__` script tag content, or `null`
 *   if it's missing/malformed.
 */
function readNextDataInPage() {
  try {
    return JSON.parse(document.getElementById("__NEXT_DATA__")?.textContent ?? "null");
  } catch {
    return null;
  }
}

/**
 * Executed IN THE COLLECTIONS PAGE (see `readNextDataInPage` above) -- same
 * self-contained-function constraint applies.
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
 * Fetches one collection's items IN THE PAGE across every offset planned
 * for it, and maps the pages to push entries with `mapDesignHits`. Never
 * throws -- a failed injection or an in-browser fetch that comes back empty
 * both just yield `[]`, which the caller treats as "no items readable".
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
 * Reads the collections page's `__NEXT_DATA__` (via the injected `exec`)
 * and extracts its favorites list with the pure `extractFavoritesList`.
 * Exported so callers that need to know "what's on the page right now"
 * WITHOUT running the full sync -- the background auto-sync's hash-throttle
 * check (`background.js`) -- can share the exact same read/extract logic
 * `syncCollections` uses, and hand the result to `syncCollections` via its
 * `page` option to avoid reading twice.
 * @param {{tabId: number, exec: (tabId: number, func: Function, args?: unknown[]) => Promise<unknown>}} opts
 * @returns {Promise<{nextData: unknown, entries: import("./collections.js").CollectionPushEntry[]}|null>}
 *   `null` when the page itself couldn't be read (a hard failure) -- NOT
 *   when it reads fine but has zero collections, which is `{nextData,
 *   entries: []}`.
 */
export async function readCollectionsPage({ tabId, exec }) {
  let nextData;
  try {
    nextData = await exec(tabId, readNextDataInPage);
  } catch {
    return null;
  }
  return { nextData, entries: extractFavoritesList(nextData) };
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
 * Runs the full collections sync: read the page, push the collection list,
 * then read+push each collection's items. See the module docstring for the
 * injected-seam contract and the resolve/reject shape.
 * @param {object} opts
 * @param {number} opts.tabId
 * @param {string} opts.url the tab's URL (used to derive the handle)
 * @param {(tabId: number, func: Function, args?: unknown[]) => Promise<unknown>} opts.exec
 * @param {{pushCollections: Function, pushCollectionItems: Function}} opts.api
 * @param {(text: string, kind: string|null) => void} opts.report
 * @param {{nextData: unknown, entries: Array}} [opts.page] a pre-fetched
 *   `readCollectionsPage` result -- when supplied, `syncCollections` skips
 *   its own page read and uses this instead (the background auto-sync
 *   throttle already read the page once to compute a hash; there's no need
 *   to read it again here).
 * @returns {Promise<{collections: number, items: number, unreadable: string[]}>}
 */
export async function syncCollections({ tabId, url, exec, api, report, page }) {
  report("Reading collections…", null);

  const resolvedPage = page ?? (await readCollectionsPage({ tabId, exec }));
  if (!resolvedPage) {
    const message = "Couldn't read this page.";
    report(message, "error");
    throw new Error(message);
  }

  const { nextData, entries } = resolvedPage;
  if (entries.length === 0) {
    const message = "No collections found on this page.";
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
  if (!handle) {
    report(
      `Synced ${entries.length} collections. Couldn't read a handle to fetch their items.`,
      "ok",
    );
    return { collections: entries.length, items: 0, unreadable: [] };
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
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    report(`Reading items for "${entry.title}" (${i + 1}/${entries.length})…`, null);
    const items = await readCollectionItems(
      tabId,
      entry.list_id,
      handle,
      offsetsByList.get(entry.list_id) || [0],
      exec,
    );
    if (items.length === 0) {
      unreadableTitles.push(entry.title);
      continue;
    }
    const itemsResult = await api.pushCollectionItems("makerworld", entry.list_id, items);
    if (itemsResult.ok) {
      totalItems += items.length;
    } else {
      unreadableTitles.push(entry.title);
    }
  }

  const suffix =
    unreadableTitles.length > 0 ? ` (no items readable: ${unreadableTitles.join(", ")})` : "";
  report(`Synced ${entries.length} collections (${totalItems} items).${suffix}`, "ok");
  return { collections: entries.length, items: totalItems, unreadable: unreadableTitles };
}
