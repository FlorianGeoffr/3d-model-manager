/**
 * Pure, `chrome`-free scraping of a MakerWorld collections page's data
 * (either the inline `__NEXT_DATA__` payload or a fresh `/_next/data/...`
 * route fetch -- see `syncFlow.js`'s `readCollectionsPage`) into the shape
 * `POST /ext/collections` expects, plus the pure planning/mapping helpers
 * for pushing each collection's ITEMS (M10 Workstream A task 3 -- `POST
 * /ext/collections/{list_id}/items`). The popup reads `__NEXT_DATA__`/does
 * the actual in-page `fetch`es off the live page via
 * `chrome.scripting.executeScript` (untested, thin wiring in `popup.js`)
 * and hands the results to the pure functions here.
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
 * Locates the `favoritesList` array within either shape a collections page
 * read can hand us: the INLINE `__NEXT_DATA__` shape
 * (`{props: {pageProps: {favoritesList}}}`), or a Next.js data-route
 * response's `pageProps`, already unwrapped one level
 * (`{favoritesList: ...}`) -- see `syncFlow.js`'s `readCollectionsPage`,
 * which tries the route first (fresh) and falls back to the inline snapshot
 * (can go stale across a client-side SPA navigation). Returns `null` when
 * neither shape yields an array, so callers can distinguish "found an
 * array (even an empty one)" from "found nothing at all".
 * @param {unknown} pagePropsOrNextData
 * @returns {Array|null}
 */
function locateFavoritesList(pagePropsOrNextData) {
  const pageProps = pagePropsOrNextData?.props?.pageProps ?? pagePropsOrNextData;
  const favoritesList = pageProps?.favoritesList;
  return Array.isArray(favoritesList) ? favoritesList : null;
}

/**
 * True iff `pagePropsOrNextData` (see `locateFavoritesList` above for the
 * two accepted shapes) carries a `favoritesList` array at all -- regardless
 * of whether it's empty. Used by `readCollectionsPage` to tell "the page
 * genuinely has zero collections" apart from "couldn't find the field at
 * all" (stale/malformed snapshot), which need different user-facing
 * messages (`syncFlow.js`).
 * @param {unknown} pagePropsOrNextData
 * @returns {boolean}
 */
export function hasFavoritesList(pagePropsOrNextData) {
  return locateFavoritesList(pagePropsOrNextData) !== null;
}

/**
 * Maps a MakerWorld collections page's `favoritesList` (same field the
 * backend's SSR-scrape importer reads -- see
 * `backend/app/importers/makerworld.py`'s `list_user_lists`) to the entries
 * `POST /ext/collections` expects. Accepts either shape `locateFavoritesList`
 * does (the inline `__NEXT_DATA__` object, or a data route's `pageProps`
 * already unwrapped) so one function serves both `readCollectionsPage`
 * read paths. Entries without an `id` or `title` are dropped. Unlike the
 * backend importer (and this function's own prior behavior), PRIVATE
 * collections (`status !== 1`) are now INCLUDED -- this is the user's own
 * library manager syncing their own MakerWorld account, and most of a
 * user's real collections are typically private, so filtering them out
 * dropped nearly everything (live bug report). Defensive throughout -- a
 * missing/malformed `__NEXT_DATA__`/`pageProps`/`favoritesList` at any depth
 * (the page markup changed, or this ran on the wrong page) yields `[]`
 * rather than throwing.
 * @param {unknown} pagePropsOrNextData parsed `__NEXT_DATA__` script tag
 *   content, or a data-route response's `pageProps`
 * @returns {CollectionPushEntry[]}
 */
export function extractFavoritesListFrom(pagePropsOrNextData) {
  const favoritesList = locateFavoritesList(pagePropsOrNextData);
  if (!favoritesList) {
    return [];
  }

  const entries = [];
  for (const item of favoritesList) {
    if (!item) {
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

// GROUND TRUTH (a real logged-in browser, M11): a MakerWorld collection
// DETAIL page is `/{locale}/collections/{id}-{slug}`, e.g.
// `https://makerworld.com/en/collections/18925823-esp32` -- NO `@handle`
// segment (unlike the collections LIST page, `HANDLE_PATH_RE` above), PLURAL
// "collections", and the id may or may not carry a `-slug` suffix. This
// SUPERSEDES the earlier `{collectionsPathname}/{listId}` guess
// (`syncFlow.js`'s old `collectionsPathnameFrom`, removed) that glued the id
// onto the LIST page's own `@handle`-having pathname -- a real sync
// confirmed that route finds nothing. Kept tolerant of a locale prefix and
// of "collection" (singular) in case the real markup varies elsewhere on
// the site; explicitly does NOT match the bare `/@handle/collections` index
// page (no `@handle` segment is accepted at all here). Two capture groups:
// the numeric id, and the slug (without its leading `-`, or `undefined` when
// absent).
const COLLECTION_DETAIL_PATH_RE =
  /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?collections?\/(\d+)(?:-([^/?#]*))?\/?$/i;

// Same MakerWorld hosts `detect.js` gates on -- duplicated locally rather
// than imported so this module stays free of a cross-file dependency for one
// small constant (mirrors `background.js`/`popup.js`'s already-duplicated
// `execInTab`).
const MAKERWORLD_HOSTS = new Set(["makerworld.com", "www.makerworld.com"]);

/**
 * Given raw anchor hrefs (absolute or relative, as collected from a
 * MakerWorld page's `a[href]` elements) and the list ids just pushed via
 * `pushCollections`, returns a `Map(listId -> pathname)` of the FIRST
 * matching REAL link found for each id -- the actual pathname the browser
 * would navigate to for that collection's detail page (ground-truth shape,
 * `COLLECTION_DETAIL_PATH_RE` above), as opposed to a constructed guess.
 * `syncFlow.js`'s `syncCollections` tries this source FIRST, before the
 * constructed `collectionDetailPathnameFrom` fallback below, since a real
 * link can never be wrong about its own shape.
 *
 * Same-origin only (an absolute href resolving to a non-MakerWorld host is
 * skipped -- a foreign share link could coincidentally match the path
 * shape). A relative href (doesn't parse as an absolute URL) is treated as
 * same-origin by construction. Query strings/hashes are stripped. When
 * multiple hrefs match the same list id, the FIRST one wins.
 * @param {Array<string>} hrefs
 * @param {Array<string>} listIds
 * @returns {Map<string, string>}
 */
export function matchCollectionLinks(hrefs, listIds) {
  const ids = new Set((listIds || []).map(String));
  const result = new Map();
  for (const href of hrefs || []) {
    if (typeof href !== "string" || !href) {
      continue;
    }
    let pathname;
    try {
      const parsed = new URL(href);
      if (!MAKERWORLD_HOSTS.has(parsed.hostname.toLowerCase())) {
        continue; // foreign origin
      }
      pathname = parsed.pathname;
    } catch {
      // Not parseable as an absolute URL -- treat as an already-relative
      // pathname, stripping any query string/hash by hand.
      pathname = href.split("?")[0].split("#")[0];
    }
    const match = COLLECTION_DETAIL_PATH_RE.exec(pathname);
    if (!match) {
      continue;
    }
    const id = match[1];
    if (!ids.has(id) || result.has(id)) {
      continue;
    }
    result.set(id, pathname.replace(/\/$/, ""));
  }
  return result;
}

// A plausible locale segment (`en`, `de`, `en-us`, ...) -- loose on purpose
// (this only needs to recognize the SITE'S OWN locale prefixes, not validate
// real ISO codes); a false positive here just means a made-up two-letter
// first path segment gets treated as a locale, which is harmless since the
// resulting pathname would 404 the same way an omitted locale might.
const LOCALE_SEGMENT_RE = /^[a-z]{2}(?:-[a-z]{2})?$/i;

/**
 * Best-effort locale prefix (`"en"`, `"de-de"`, ...) read off `url`'s own
 * leading path segment, or `null` when there isn't one. Used by
 * `collectionDetailPathnameFrom` below to build a same-locale detail-page
 * pathname -- the collection's own data never carries a locale, but the
 * page the user is currently on does.
 * @param {string} url
 * @returns {string|null}
 */
function localeFromUrl(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const first = pathname.split("/").filter(Boolean)[0];
  return first && LOCALE_SEGMENT_RE.test(first) ? first.toLowerCase() : null;
}

/**
 * Builds a collection's detail-page pathname straight from its OWN pushed
 * data (ground-truth shape: `/{locale}/collections/{listId}-{slug}`, e.g.
 * `/en/collections/18925823-esp32`) instead of guessing at a route derived
 * from the LIST page's pathname (the old, now-confirmed-wrong
 * `{collectionsPathname}/{listId}` construction this replaces). Omits the
 * `-slug` suffix when the entry has no slug (`/collections/{listId}`) --
 * still a plausible real route, just untested since every live capture so
 * far has carried a slug. `syncFlow.js`'s `syncCollections` tries this AFTER
 * an anchor-derived pathname (`matchCollectionLinks` above, when a real link
 * was found) since a real link is always more trustworthy than a
 * construction, however ground-truth-informed.
 * @param {string} url the tab's current URL (only its locale prefix, if any,
 *   is used)
 * @param {string} listId
 * @param {string|null} [slug]
 * @returns {string}
 */
export function collectionDetailPathnameFrom(url, listId, slug) {
  const locale = localeFromUrl(url);
  const prefix = locale ? `/${locale}` : "";
  return slug ? `${prefix}/collections/${listId}-${slug}` : `${prefix}/collections/${listId}`;
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
 * Pure paging plan: for every pushed collection (the `extractFavoritesListFrom`
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
 * same fields, same URL shape -- but, like `extractFavoritesListFrom` above,
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

// Checked (in this order) before falling back to the generic deep-scan --
// plausible field names for a per-collection design list on the
// collection's own SSR data route. UNVERIFIED (no live capture of exactly
// which key the route uses was taken for this task -- see
// `syncFlow.js`'s `readCollectionItemsFromDataRoute` doc for why this needs
// to be tolerant at all: the old `/api/v1/.../favorites/designs/{listId}`
// in-page fetch produced zero items on a real sync). `"designs"` and
// `"favoritesDesigns"` are SPECIFIC to a single collection's own item list;
// `"list"` is generic enough that it carries no such guarantee on its own
// (F1 hardening -- see `TRUSTED_EMPTY_KEYS` below).
const DESIGN_LIST_KEYS = ["designs", "favoritesDesigns", "list"];

// The subset of `DESIGN_LIST_KEYS` whose EMPTY array is still trusted as
// "this collection genuinely has zero items" rather than "wrong array" (F1
// hardening). The generic `"list"` key is deliberately excluded: MakerWorld's
// own collections-LIST payload (`favoritesList`, `extractFavoritesListFrom`)
// is exactly the kind of array that could plausibly land under a
// similarly-generic key too, so an empty `"list"` proves nothing and must
// not short-circuit the search -- see `findDesignListIn` below.
const TRUSTED_EMPTY_KEYS = new Set(["designs", "favoritesDesigns"]);

// Never a collection's OWN items -- this is the collections-LIST field
// itself (`extractFavoritesListFrom`'s source, mapped straight off
// `favoritesList` entries). Excluded from BOTH the named-key check and the
// deep-scan fallback in `findDesignListIn` below (F1 hardening, the
// important fix): a collection data-route response that also happens to
// carry the account's full collections list under `pageProps.favoritesList`
// must never be mistaken for THIS collection's items, even though a
// `favoritesList` entry carries an `id` and a `title` just like a design
// object would.
const EXCLUDED_KEYS = new Set(["favoritesList"]);

/**
 * True iff `value` looks like one MakerWorld design/model object: an object
 * with a numeric `id` and a `title`- or `name`-ish string field, and NEITHER
 * of the markers that identify a *collection* object instead: `designCnt`
 * (a collection's item count) or `isDefault` (a collection's "is this the
 * account's default collection" flag) -- see `extractFavoritesListFrom`'s
 * `CollectionPushEntry` mapping, which reads exactly these two fields off a
 * `favoritesList` entry. This collection-marker rejection is F1 hardening's
 * shape-level backstop: `EXCLUDED_KEYS` above only blocks the field
 * literally named `favoritesList`, but a collections-list array could in
 * principle turn up under some OTHER key too (a differently-shaped route
 * response, a renamed field) -- rejecting anything carrying a collection
 * marker, regardless of which key it's under, is the required part of the
 * fix. Used both to validate a named-key candidate and to drive the
 * deep-scan fallback in `findDesignListIn` below.
 * @param {unknown} value
 * @returns {boolean}
 */
function looksLikeDesign(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.id !== "number" ||
    !(typeof value.title === "string" || typeof value.name === "string")
  ) {
    return false;
  }
  return !("designCnt" in value || "isDefault" in value);
}

/**
 * True iff a non-empty array has AT LEAST ONE non-null entry that looks
 * design-shaped (`looksLikeDesign`), and every other entry is either `null`
 * or also design-shaped. Requiring at least one non-null hit is F4 hardening
 * -- an array of nothing but `null`s previously passed this check (every
 * item WAS `null`, vacuously satisfying the old all-or-nothing test) despite
 * carrying zero actual design-shape evidence. An empty array can't be
 * shape-validated at all -- callers decide separately whether an empty array
 * is still trustworthy (see `findDesignListIn`'s named-key branch,
 * `TRUSTED_EMPTY_KEYS`).
 * @param {Array} array
 * @returns {boolean}
 */
function isDesignShapedArray(array) {
  return (
    array.length > 0 &&
    array.some((item) => looksLikeDesign(item)) &&
    array.every((item) => item === null || looksLikeDesign(item))
  );
}

/**
 * Tolerantly locates the array of design-shaped objects within a
 * collection's own SSR data-route `pageProps` (M10 Workstream: the field
 * name carrying a *named* collection's items on this route was NOT
 * captured live for this task -- the old `/api/v1/design-service/favorites
 * /designs/{listId}` in-page fetch this is now the PRIMARY replacement for
 * produced zero items on a real sync, either because handle extraction
 * failed or because that endpoint is uid-aggregate-only even in a real
 * browser). Tries known plausible keys first (`DESIGN_LIST_KEYS`, in
 * order) -- a non-empty match there is shape-validated, and an EMPTY array
 * under a SPECIFIC named key (`TRUSTED_EMPTY_KEYS`) is still trusted (the
 * key name itself is the signal: "this collection genuinely has zero items"
 * is a legitimate outcome, and an empty array can't be shape-validated
 * anyway) -- but an empty array under the GENERIC `"list"` key carries no
 * such guarantee and does NOT short-circuit the search (F1 hardening).
 * Only when no named key matches does it fall back to a generic deep-scan
 * (top level, and one level into any nested plain object, both skipping
 * `EXCLUDED_KEYS`) for ANY non-empty array whose items are design-shaped --
 * deep-scan needs shape validation AND non-emptiness to have any confidence
 * it found the right thing, since the key name carries no signal there.
 * Returns `null` when nothing matches at either level, so callers know to
 * fall back to the `/api/v1` endpoint.
 * @param {unknown} pageProps a collection data-route response's `pageProps`
 * @returns {{key: string, designs: Array}|null}
 */
export function findDesignListIn(pageProps) {
  if (!pageProps || typeof pageProps !== "object") {
    return null;
  }

  for (const key of DESIGN_LIST_KEYS) {
    const candidate = pageProps[key];
    if (!Array.isArray(candidate)) {
      continue;
    }
    if (candidate.length === 0) {
      if (TRUSTED_EMPTY_KEYS.has(key)) {
        return { key, designs: candidate };
      }
      continue; // generic "list": an empty array proves nothing -- keep looking
    }
    if (isDesignShapedArray(candidate)) {
      return { key, designs: candidate };
    }
  }

  for (const [key, value] of Object.entries(pageProps)) {
    if (EXCLUDED_KEYS.has(key)) {
      continue; // the collections LIST itself, never a collection's items
    }
    if (DESIGN_LIST_KEYS.includes(key)) {
      continue; // already checked above
    }
    if (Array.isArray(value) && isDesignShapedArray(value)) {
      return { key, designs: value };
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (EXCLUDED_KEYS.has(nestedKey)) {
          continue;
        }
        if (Array.isArray(nestedValue) && isDesignShapedArray(nestedValue)) {
          return { key: `${key}.${nestedKey}`, designs: nestedValue };
        }
      }
    }
  }

  return null;
}
