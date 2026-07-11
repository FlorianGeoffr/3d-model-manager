/**
 * MV3 service worker. Wires together the pure modules (`detect.js`,
 * `courier.js`, `api.js`, `config.js`) with the `chrome.*` APIs. Nothing in
 * here is unit-tested directly (it needs a live extension context); the
 * logic it delegates to (site/model-page detection, the cookie-changed
 * diff) IS covered by `test/detect.test.js` and `test/courier.test.js`.
 */

import { isModelPage } from "./detect.js";
import { createClient } from "./api.js";
import { getConfig, isConfigured, setConfig } from "./config.js";
import { hashToken, pickCookieValue, shouldPush } from "./courier.js";

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
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === COURIER_ALARM_NAME) {
    runCourier();
  }
});
