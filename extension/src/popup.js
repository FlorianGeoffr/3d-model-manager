/**
 * Popup UI. Reads config + the active tab, then renders one of four
 * states: "set up the extension", "not a model page", "save this model",
 * or "sync collections" (on a MakerWorld collections page). All the
 * `chrome.*` calls live here; the URL/scrape/planning logic they feed is
 * `isModelPage`/`isCollectionsPage` (`detect.js`) and `extractFavoritesList`/
 * `extractHandle`/`buildItemsFetchPlan`/`mapDesignHits` (`collections.js`)
 * -- all unit-tested. "Sync collections to app" pushes both the collection
 * list AND (M10 Workstream A task 3) each collection's items, the latter
 * read straight out of the page via `chrome.scripting.executeScript` so the
 * fetch carries the page's own cookies/`cf_clearance`.
 */

import { isCollectionsPage, isModelPage } from "./detect.js";
import { getConfig, isConfigured } from "./config.js";
import { createClient } from "./api.js";
import {
  buildItemsFetchPlan,
  extractFavoritesList,
  extractHandle,
  mapDesignHits,
} from "./collections.js";

const messageEl = document.getElementById("message");
const actionsEl = document.getElementById("actions");
const statusEl = document.getElementById("status");

// Matches the backend's own page size (`_SEARCH_PAGE_SIZE`,
// `backend/app/importers/makerworld.py`) so a page pulled in-browser lines
// up with how the app would page the same endpoint.
const ITEMS_PAGE_SIZE = 20;

function setStatus(text, kind) {
  statusEl.textContent = text || "";
  statusEl.className = kind ? `status ${kind}` : "status";
}

function renderSetup() {
  messageEl.textContent =
    "Set up the extension with your app's address and API token before saving models.";
  const link = document.createElement("a");
  link.className = "button primary";
  link.href = "#";
  link.textContent = "Set up the extension";
  link.addEventListener("click", (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });
  actionsEl.replaceChildren(link);
}

function renderNotAModelPage() {
  messageEl.textContent = "This isn't a MakerWorld, Thingiverse, or Printables model page.";
  const button = document.createElement("button");
  button.textContent = "Save to my library";
  button.disabled = true;
  actionsEl.replaceChildren(button);
}

function renderSavable(url) {
  messageEl.textContent = "Send this model to your library.";
  const button = document.createElement("button");
  button.className = "primary";
  button.textContent = "Save to my library";
  button.addEventListener("click", () => handleSave(button, url));
  actionsEl.replaceChildren(button);
}

function renderSyncCollections(tabId, url, config) {
  messageEl.textContent = "Sync your MakerWorld collections into the app.";
  const button = document.createElement("button");
  button.className = "primary";
  button.textContent = "Sync collections to app";
  button.addEventListener("click", () => handleSyncCollections(button, tabId, url, config));
  actionsEl.replaceChildren(button);
}

/**
 * Executed IN THE COLLECTIONS PAGE (via `chrome.scripting.executeScript`),
 * not the service worker -- the page's own origin carries the browser's
 * cookies/`cf_clearance` a background-worker `fetch` couldn't (M10
 * Workstream A task 3). Must be fully self-contained: `chrome.scripting`
 * serializes this function's source and re-evaluates it in the page's
 * isolated world, so it cannot close over anything from this module -- only
 * its own `args` and globals the page provides (`fetch`).
 * @param {string} listId
 * @param {string} handle
 * @param {number[]} offsets
 * @returns {Promise<Array<unknown>>} one parsed JSON response per offset (or
 *   `null` for an offset whose fetch failed/didn't parse as JSON) -- fed to
 *   `mapDesignHits` back in the popup.
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
 * Fetches one collection's items IN THE PAGE (see
 * `fetchCollectionItemsInPage`) across every offset `buildItemsFetchPlan`
 * planned for it, and maps the pages to push entries with `mapDesignHits`.
 * Never throws -- a failed injection or an in-browser fetch that comes back
 * empty both just yield `[]`, which the caller treats as "no items readable".
 */
async function readCollectionItems(tabId, listId, handle, offsets) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      func: fetchCollectionItemsInPage,
      args: [listId, handle, offsets],
    });
  } catch {
    return [];
  }
  const pages = (results && results[0] && results[0].result) || [];
  const items = [];
  for (const page of pages) {
    items.push(...mapDesignHits(page));
  }
  return items;
}

/**
 * Reads the collections page's `__NEXT_DATA__` out of the tab via
 * `chrome.scripting.executeScript` (the only way to reach page content from
 * a service worker), extracts the favorites list with the pure
 * `extractFavoritesList`, and pushes it to the app. Then, for each pushed
 * collection, reads its items straight out of the page (same technique --
 * the page origin carries the auth a background-worker fetch couldn't) and
 * pushes those too (M10 Workstream A task 3), so one click captures both
 * the collection list AND each collection's contents.
 */
async function handleSyncCollections(button, tabId, url, config) {
  button.disabled = true;
  setStatus("Reading collections…", null);

  let injectionResults;
  try {
    injectionResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          return JSON.parse(document.getElementById("__NEXT_DATA__")?.textContent ?? "null");
        } catch {
          return null;
        }
      },
    });
  } catch {
    setStatus("Couldn't read this page.", "error");
    button.disabled = false;
    return;
  }

  const nextData = injectionResults && injectionResults[0] && injectionResults[0].result;
  const entries = extractFavoritesList(nextData);
  if (entries.length === 0) {
    setStatus("No collections found on this page.", "error");
    button.disabled = false;
    return;
  }

  setStatus("Syncing…", null);
  const client = createClient({ baseUrl: config.appBaseUrl, token: config.apiToken });
  const listResult = await client.pushCollections("makerworld", entries);
  if (!listResult.ok) {
    setStatus(listResult.error || "Something went wrong.", "error");
    button.disabled = false;
    return;
  }

  const handle = extractHandle(nextData, url);
  if (!handle) {
    setStatus(
      `Synced ${entries.length} collections. Couldn't read a handle to fetch their items.`,
      "ok",
    );
    button.disabled = false;
    return;
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
    setStatus(`Reading items for "${entry.title}" (${i + 1}/${entries.length})…`, null);
    const items = await readCollectionItems(
      tabId,
      entry.list_id,
      handle,
      offsetsByList.get(entry.list_id) || [0],
    );
    if (items.length === 0) {
      unreadableTitles.push(entry.title);
      continue;
    }
    const itemsResult = await client.pushCollectionItems("makerworld", entry.list_id, items);
    if (itemsResult.ok) {
      totalItems += items.length;
    } else {
      unreadableTitles.push(entry.title);
    }
  }

  const suffix =
    unreadableTitles.length > 0 ? ` (no items readable: ${unreadableTitles.join(", ")})` : "";
  setStatus(`Synced ${entries.length} collections (${totalItems} items).${suffix}`, "ok");
  button.disabled = false;
}

async function handleSave(button, url) {
  button.disabled = true;
  setStatus("Saving…", null);
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "save", url });
  } catch {
    // The background service worker's message port can reject/close out
    // from under us (e.g. it was asleep and got killed again). Don't leave
    // the button stuck disabled on "Saving…" — restore it with a generic
    // error instead.
    setStatus("Something went wrong.", "error");
    button.disabled = false;
    return;
  }
  if (response && response.needsConfig) {
    setStatus("The extension isn't configured yet.", "error");
    button.disabled = false;
    return;
  }
  if (response && response.ok) {
    setStatus(
      response.status === 201 ? "Added to your library." : "Saved — already in your library.",
      "ok"
    );
    return;
  }
  setStatus((response && response.error) || "Something went wrong.", "error");
  button.disabled = false;
}

async function init() {
  const config = await getConfig();
  if (!isConfigured(config)) {
    renderSetup();
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab && tab.url;
  if (url && isModelPage(url)) {
    renderSavable(url);
    return;
  }
  if (url && tab.id !== undefined && isCollectionsPage(url)) {
    renderSyncCollections(tab.id, url, config);
    return;
  }

  renderNotAModelPage();
}

init();
