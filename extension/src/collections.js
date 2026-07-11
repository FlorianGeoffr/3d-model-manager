/**
 * Pure, `chrome`-free scraping of a MakerWorld collections page's
 * `__NEXT_DATA__` payload into the shape `POST /ext/collections` expects,
 * plus the pure planning/mapping helpers for pushing each collection's
 * ITEMS (M10 Workstream A task 3 -- `POST /ext/collections/{list_id}/items`).
 * The popup reads `__NEXT_DATA__`/does the actual in-page `fetch`es off the
 * live page via `chrome.scripting.executeScript` (untested, thin wiring in
 * `popup.js`) and hands the results to the pure functions here.
 */

/**
 * @typedef {{
 *   list_id: string,
 *   title: string,
 *   slug: string|null,
 *   count: number|null,
 *   is_default: boolean,
 * }} CollectionPushEntry
 */

/**
 * Maps a MakerWorld collections page's `__NEXT_DATA__.props.pageProps
 * .favoritesList` (same field the backend's SSR-scrape importer reads --
 * see `backend/app/importers/makerworld.py`'s `list_user_lists`) to the
 * entries `POST /ext/collections` expects. Mirrors that importer's
 * filtering: only `status === 1` (visible) entries, and entries without an
 * `id` or `title` are dropped. Defensive throughout -- a missing/malformed
 * `__NEXT_DATA__`, `props`, `pageProps`, or `favoritesList` at any depth
 * (the page markup changed, or this ran on the wrong page) yields `[]`
 * rather than throwing.
 * @param {unknown} nextDataJson parsed `__NEXT_DATA__` script tag content
 * @returns {CollectionPushEntry[]}
 */
export function extractFavoritesList(nextDataJson) {
  const favoritesList = nextDataJson?.props?.pageProps?.favoritesList;
  if (!Array.isArray(favoritesList)) {
    return [];
  }

  const entries = [];
  for (const item of favoritesList) {
    if (!item || item.status !== 1) {
      continue;
    }
    const id = item.id;
    const title = item.title;
    if (!id || !title) {
      continue;
    }
    entries.push({
      list_id: String(id),
      title,
      slug: item.slug ?? null,
      count: item.designCnt ?? null,
      is_default: Boolean(item.isDefault),
    });
  }
  return entries;
}

// `/@<handle>/collections`, same path shape `detect.js`'s
// `COLLECTIONS_PATH_PATTERN` already gates the sync button on -- a page that
// reached `extractHandle` is guaranteed to match this.
const HANDLE_PATH_RE = /\/@([^/]+)\/collections(?:\/.*)?$/i;

/**
 * Best-effort MakerWorld handle (the account's `name`, e.g. "Terminalfoo")
 * for the signed-in user viewing the collections page -- needed to build
 * the favorites/items fetch URL the same way the backend's `_profile`-
 * derived `@{handle}` does (`backend/app/importers/makerworld.py`).
 *
 * The RELIABLE source is the page's own URL: a page that reached this code
 * already matched `isCollectionsPage` (`detect.js`), which requires a
 * literal `/@<handle>/collections` path segment -- so the URL always
 * succeeds on the one page type this runs on, and is tried FIRST. A couple
 * of plausible `__NEXT_DATA__` shapes are tried only as a fallback when the
 * URL can't be parsed (UNVERIFIED -- no live capture of exactly where the
 * collections page's own SSR props carry this was taken for this task), so
 * an unverified guess never overrides the value the URL guarantees.
 * @param {unknown} nextDataJson parsed `__NEXT_DATA__` script tag content
 * @param {string} url the tab's URL
 * @returns {string|null}
 */
export function extractHandle(nextDataJson, url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = null;
  }
  if (pathname) {
    const match = HANDLE_PATH_RE.exec(pathname);
    if (match) {
      return decodeURIComponent(match[1]);
    }
  }
  const pageProps = nextDataJson?.props?.pageProps;
  const fromNextData =
    pageProps?.userInfo?.name ?? pageProps?.profile?.name ?? pageProps?.accountInfo?.name ?? null;
  return typeof fromNextData === "string" && fromNextData ? fromNextData : null;
}

/**
 * @typedef {{
 *   external_id: string,
 *   title: string,
 *   url: string,
 *   author: string|null,
 *   thumbnail_url: string|null,
 * }} CollectionItemPushEntry
 */

// Mirrors the ext API's own cap (`backend/app/api/ext.py`'s
// `_MAX_PUSHED_ITEMS`) -- a plan that requested more than this would just
// have its tail rejected by the push, so there's no point building it.
const MAX_ITEMS_PER_COLLECTION = 500;

/**
 * Pure paging plan: for every pushed collection (the `extractFavoritesList`
 * entries, each carrying its own `count`), the `{listId, offset}` requests
 * needed to walk its full item count in `pageSize`-sized pages, capped at
 * `MAX_ITEMS_PER_COLLECTION` items/collection (matching the ext push
 * endpoint's own limit). A collection with no known `count` (null/0/absent
 * -- MakerWorld's own SSR scrape doesn't always carry one) still gets
 * exactly one page (offset 0): the only page a fetch can be planned for
 * without first knowing how many there are, and better than skipping the
 * collection outright.
 * @param {Array<{list_id: string, count: number|null}>} collections
 * @param {number} [pageSize]
 * @returns {Array<{listId: string, offset: number}>}
 */
export function buildItemsFetchPlan(collections, pageSize = 20) {
  if (!Array.isArray(collections)) {
    return [];
  }
  const plan = [];
  for (const entry of collections) {
    if (!entry || !entry.list_id) {
      continue;
    }
    const knownCount =
      typeof entry.count === "number" && entry.count > 0 ? entry.count : pageSize;
    const cappedCount = Math.min(knownCount, MAX_ITEMS_PER_COLLECTION);
    const pageCount = Math.max(1, Math.ceil(cappedCount / pageSize));
    for (let page = 0; page < pageCount; page++) {
      plan.push({ listId: entry.list_id, offset: page * pageSize });
    }
  }
  return plan;
}

/**
 * Maps one page of MakerWorld's `/design-service/favorites/designs/{listId}`
 * response (`{hits: [design...], total}`) to the shape `POST /ext/
 * collections/{list_id}/items` expects. Mirrors the backend's own mapping
 * for the SAME endpoint (`MakerWorldImporter.list_list_items`'s
 * `SearchResult` construction, `backend/app/importers/makerworld.py`) --
 * same fields, same URL shape -- but, like `extractFavoritesList` above,
 * drops any entry missing an id or a title rather than the backend's
 * `f"model {id}"` placeholder-title fallback (this is a client-side scrape
 * of live page data, not an authoritative import -- silently dropping a
 * malformed hit is safer than pushing a placeholder title into the app).
 * Defensive throughout -- a missing/malformed `hits` array yields `[]`.
 * @param {unknown} designHitsResponse parsed favorites-endpoint response JSON
 * @returns {CollectionItemPushEntry[]}
 */
export function mapDesignHits(designHitsResponse) {
  const hits = designHitsResponse?.hits;
  if (!Array.isArray(hits)) {
    return [];
  }

  const items = [];
  for (const design of hits) {
    if (!design) {
      continue;
    }
    const id = design.id;
    const title = design.title;
    if (!id || !title) {
      continue;
    }
    items.push({
      external_id: String(id),
      title,
      url: `https://makerworld.com/en/models/${id}`,
      author: design.designCreator?.name ?? null,
      thumbnail_url: design.cover ?? null,
    });
  }
  return items;
}
