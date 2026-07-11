/**
 * Popup UI. Reads config + the active tab, then renders one of four
 * states: "set up the extension", "not a model page", "save this model",
 * or "sync collections" (on a MakerWorld collections page). All the
 * `chrome.*` calls live here; the URL/scrape logic they feed is
 * `isModelPage`/`isCollectionsPage` (`detect.js`) and `extractFavoritesList`
 * (`collections.js`) -- all unit-tested.
 */

import { isCollectionsPage, isModelPage } from "./detect.js";
import { getConfig, isConfigured } from "./config.js";
import { createClient } from "./api.js";
import { extractFavoritesList } from "./collections.js";

const messageEl = document.getElementById("message");
const actionsEl = document.getElementById("actions");
const statusEl = document.getElementById("status");

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

function renderSyncCollections(tabId, config) {
  messageEl.textContent = "Sync your MakerWorld collections into the app.";
  const button = document.createElement("button");
  button.className = "primary";
  button.textContent = "Sync collections to app";
  button.addEventListener("click", () => handleSyncCollections(button, tabId, config));
  actionsEl.replaceChildren(button);
}

/**
 * Reads the collections page's `__NEXT_DATA__` out of the tab via
 * `chrome.scripting.executeScript` (the only way to reach page content from
 * a service worker), extracts the favorites list with the pure
 * `extractFavoritesList`, and pushes it to the app.
 */
async function handleSyncCollections(button, tabId, config) {
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
  const result = await client.pushCollections("makerworld", entries);
  if (result.ok) {
    setStatus(`Synced ${entries.length} collections.`, "ok");
  } else {
    setStatus(result.error || "Something went wrong.", "error");
  }
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
    renderSyncCollections(tab.id, config);
    return;
  }

  renderNotAModelPage();
}

init();
