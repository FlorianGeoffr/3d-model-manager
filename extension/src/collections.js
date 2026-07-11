/**
 * Pure, `chrome`-free scraping of a MakerWorld collections page's
 * `__NEXT_DATA__` payload into the shape `POST /ext/collections` expects.
 * The popup reads `__NEXT_DATA__` off the live page via
 * `chrome.scripting.executeScript` (untested, thin wiring in `popup.js`)
 * and hands the parsed JSON to `extractFavoritesList` here.
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
