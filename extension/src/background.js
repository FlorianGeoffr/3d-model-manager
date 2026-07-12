/**
 * MV3 service worker. Wires together the pure modules (`detect.js`,
 * `courier.js`, `api.js`, `config.js`, `syncFlow.js`) with the `chrome.*`
 * APIs. Nothing in here is unit-tested directly (it needs a live extension
 * context); the logic it delegates to (site/model-page/collections-page
 * detection, the cookie-changed diff, the collections sync flow itself) IS
 * covered by `test/detect.test.js`, `test/courier.test.js`, and
 * `test/syncFlow.test.js`.
 */

import { isCollectionsPage, isModelPage } from "./detect.js";
import { createClient } from "./api.js";
import { getConfig, isConfigured, setConfig } from "./config.js";
import { hashToken, pickCookieValue, shouldPush } from "./courier.js";
import {
  hashCollectionsPayload,
  readCollectionsPage,
  shouldPersistHash,
  shouldPushCollections,
  syncCollections,
} from "./syncFlow.js";

const GALLERY_HOST_PATTERNS = [
  "*://makerworld.com/*",
  "*://www.makerworld.com/*",
  "*://thingiverse.com/*",
  "*://www.thingiverse.com/*",
  "*://printables.com/*",
  "*://www.printables.com/*",
];

const CONTEXT_MENU_PAGE_ID = "save-to-my-library-page";
const CONTEXT_MENU_LINK_ID = "save-to-my-library-link";
const COURIER_ALARM_NAME = "makerworld-courier";
const COURIER_ALARM_PERIOD_MINUTES = 30;
const MAKERWORLD_COOKIE_DOMAIN = "makerworld.com";
const MAKERWORLD_COOKIE_HOSTS = new Set(["makerworld.com", "www.makerworld.com"]);
const MAKERWORLD_COOKIE_NAME = "token";
const BADGE_FLASH_MS = 3000;
const BADGE_OK_COLOR = "#2e7d32";
const BADGE_ERROR_COLOR = "#b3261e";

function ensureContextMenu() {
  // Two separate items, not one item with both contexts: Chrome ANDs
  // `documentUrlPatterns` and `targetUrlPatterns` together on a single
  // item, so a combined item would require the CURRENT PAGE to also be a
  // gallery host before a matching LINK's menu entry could ever show —
  // which would hide the entry for the common case of right-clicking a
  // gallery link from an unrelated page (a forum post, a search result,
  // etc). Splitting keeps each restriction independent.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_PAGE_ID,
      title: "Save model to my library",
      contexts: ["page"],
      documentUrlPatterns: GALLERY_HOST_PATTERNS,
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_LINK_ID,
      title: "Save model to my library",
      contexts: ["link"],
      targetUrlPatterns: GALLERY_HOST_PATTERNS,
    });
  });
}

function ensureCourierAlarm() {
  chrome.alarms.create(COURIER_ALARM_NAME, { periodInMinutes: COURIER_ALARM_PERIOD_MINUTES });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureContextMenu();
  ensureCourierAlarm();
});

// Alarms persist across browser restarts, but re-asserting on startup is
// cheap and guards against the alarm having been cleared some other way.
chrome.runtime.onStartup.addListener(() => {
  ensureCourierAlarm();
});

/**
 * Shared "save this URL" flow used by both the popup's message and the
 * context-menu click. Never throws — always resolves to either
 * `{needsConfig:true}` or the normalized `api.js` result.
 * @param {string} url
 */
async function saveUrl(url) {
  const config = await getConfig();
  if (!isConfigured(config)) {
    return { needsConfig: true };
  }
  const client = createClient({ baseUrl: config.appBaseUrl, token: config.apiToken });
  return client.createImport(url);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "save" && typeof message.url === "string") {
    saveUrl(message.url).then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  return false;
});

async function flashBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "" });
  }, BADGE_FLASH_MS);
}

// We didn't request the `notifications` permission (see manifest), so
// context-menu feedback is a brief action-badge flash instead of a toast.
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== CONTEXT_MENU_PAGE_ID && info.menuItemId !== CONTEXT_MENU_LINK_ID) {
    return;
  }
  const url = info.linkUrl || info.pageUrl;
  if (!url || !isModelPage(url)) {
    await flashBadge("!", BADGE_ERROR_COLOR);
    return;
  }
  const result = await saveUrl(url);
  if (result && result.ok) {
    await flashBadge("✓", BADGE_OK_COLOR);
  } else if (result && result.needsConfig) {
    // Not just a badge flash: an unexplained "!" doesn't tell the user
    // *why* the save failed, so send them straight to setup.
    await chrome.runtime.openOptionsPage();
  } else {
    await flashBadge("!", BADGE_ERROR_COLOR);
  }
});

/**
 * Reads the MakerWorld `token` cookie and, if it's present and different
 * from the last successfully-pushed value (compared by hash — the raw
 * cookie is never persisted), couriers it to the app and records the new
 * hash on success.
 */
async function runCourier() {
  const config = await getConfig();
  if (!config.autoCourier || !isConfigured(config)) {
    return;
  }
  const cookies = await chrome.cookies.getAll({
    domain: MAKERWORLD_COOKIE_DOMAIN,
    name: MAKERWORLD_COOKIE_NAME,
  });
  const value = pickCookieValue(cookies);
  if (!value) {
    return;
  }
  const needsPush = await shouldPush(value, config.lastMakerworldHash);
  if (!needsPush) {
    return;
  }
  const client = createClient({ baseUrl: config.appBaseUrl, token: config.apiToken });
  const result = await client.setMakerworldCredential(value);
  if (result.ok) {
    const newHash = await hashToken(value);
    await setConfig({ lastMakerworldHash: newHash });
  }
}

/**
 * `exec(tabId, func, args)` seam `syncFlow.js` needs -- the one place this
 * file wraps `chrome.scripting.executeScript` for the collections flow
 * (mirrors `popup.js`'s identically-named helper; both wrap the same
 * `chrome.*` call, but each file owns its own thin copy rather than adding
 * a shared module just for this).
 */
async function execInTab(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return results && results[0] && results[0].result;
}

/**
 * Auto-sync entry point (import-health branch T5): runs the SAME shared
 * flow the popup's "Sync collections to app" button uses (`syncFlow.js`),
 * triggered by simply VISITING the MakerWorld collections page instead of
 * requiring a manual click. Mirrors `runCourier`'s shape -- gated on its
 * own setting (`autoSyncCollections`), and since there's no popup open to
 * show an error to, failures are logged to `console.*` only and NEVER
 * thrown/surfaced to the tab.
 *
 * Throttled like the cookie courier (`shouldPush`/`lastMakerworldHash`),
 * but on the pushed collections payload instead of the cookie
 * (`shouldPushCollections`/`lastCollectionsHash`, `syncFlow.js`). The
 * comparison happens BEFORE any push (list or items) -- an unchanged page
 * costs nothing but the one in-page read that produced `entries`. Note:
 * `entries` carries each collection's `count` (MakerWorld's `designCnt`),
 * so adding/removing an item from a named collection necessarily changes
 * that collection's `count` and therefore the hash -- membership changes
 * are covered by hashing the list alone, without needing to hash the
 * fetched item ids too. (Not independently re-verified live for this task
 * -- `designCnt` being a literal per-collection item count makes this the
 * only sane reading, and M9's capture notes found no way to probe MakerWorld
 * from a server IP to double-check; if a future capture ever shows
 * `designCnt` staying put across a real membership edit, this reasoning --
 * and the throttle -- needs revisiting.)
 *
 * An empty `entries` read is treated as "nothing to sync" and never pushed
 * automatically -- MakerWorld's own scrape can come back transiently empty
 * from a real browser same as it does from the server (see the README's
 * "empty isn't proof of empty" caution for the courier), and blowing away
 * real cached collections on a flaky read would be worse than doing nothing
 * until the next successful visit.
 *
 * The same caution applies one level down: a run where the LIST read fine
 * but one or more collections' ITEMS came back unreadable
 * (`result.unreadable`, `syncFlow.js`) still pushed what it could, but must
 * NOT advance `lastCollectionsHash` (`shouldPersistHash`) -- otherwise the
 * throttle would treat that partial run as done and never retry the
 * unreadable collections until the list itself changes.
 */
async function runCollectionsSync(tabId, url) {
  const config = await getConfig();
  if (!config.autoSyncCollections || !isConfigured(config)) {
    return;
  }

  const page = await readCollectionsPage({ tabId, exec: execInTab });
  if (!page) {
    console.error("[collections auto-sync] couldn't read the collections page");
    return;
  }
  if (page.entries.length === 0) {
    return;
  }

  const needsPush = await shouldPushCollections(page.entries, config.lastCollectionsHash);
  if (!needsPush) {
    return;
  }

  const client = createClient({ baseUrl: config.appBaseUrl, token: config.apiToken });
  let result;
  try {
    result = await syncCollections({
      tabId,
      url,
      exec: execInTab,
      api: client,
      page,
      report: (text, kind) => {
        const line = `[collections auto-sync] ${text}`;
        if (kind === "error") {
          console.error(line);
        } else {
          console.log(line);
        }
      },
    });
  } catch {
    // `syncCollections` already logged the failure reason above via
    // `report`. Leave `lastCollectionsHash` untouched so the next visit
    // retries instead of silently giving up forever.
    return;
  }

  if (!shouldPersistHash(result)) {
    // Partial success -- some collections' items were unreadable. Leave
    // `lastCollectionsHash` untouched (same reasoning as the catch above)
    // so the next visit retries them.
    return;
  }

  const newHash = await hashCollectionsPayload(page.entries);
  await setConfig({ lastCollectionsHash: newHash });
}

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") {
    return;
  }
  const url = tab && tab.url;
  if (!url) {
    return;
  }
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return;
  }
  if (MAKERWORLD_COOKIE_HOSTS.has(hostname)) {
    runCourier();
  }
  if (tab.id !== undefined && isCollectionsPage(url)) {
    // `runCollectionsSync` isn't awaited here (this listener can't be
    // async-blocking), so an unhandled rejection anywhere in its chain --
    // `getConfig`/`isConfigured`/`shouldPushCollections` sit outside its own
    // try/catch -- would otherwise surface as an unhandled promise
    // rejection instead of the silent-to-the-user, logged-only failure this
    // background sync is meant to be.
    runCollectionsSync(tab.id, url).catch((err) =>
      console.warn("collections auto-sync failed", err),
    );
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === COURIER_ALARM_NAME) {
    runCourier();
  }
});
