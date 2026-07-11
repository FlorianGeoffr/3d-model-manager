/**
 * Popup UI. Reads config + the active tab, then renders one of three
 * states: "set up the extension", "not a model page", or "save this
 * model". All the `chrome.*` calls live here; the URL logic they feed is
 * `isModelPage` from `detect.js` (unit-tested).
 */

import { isModelPage } from "./detect.js";
import { getConfig, isConfigured } from "./config.js";

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
  if (!url || !isModelPage(url)) {
    renderNotAModelPage();
    return;
  }

  renderSavable(url);
}

init();
