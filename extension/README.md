# Browser extension — Send to my library

A sideloaded Chrome (MV3) extension that saves MakerWorld, Thingiverse, and
Printables model pages straight into your self-hosted 3D Model Manager
library, and keeps the app's stored MakerWorld cookie fresh while you browse
— no more copying cookie values out of DevTools by hand.

## Install (sideload)

This extension isn't published to the Chrome Web Store — load it from source:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.

## Configure

1. Open the extension's options page (right-click its toolbar icon → **Options**,
   or `chrome://extensions` → the extension's **Details** → **Extension options**).
2. Enter your app's base URL, e.g. `http://your-host:8080` (no trailing path).
3. Mint an **API token** in the app itself, at **Settings → Imports → Browser
   extension**, and paste it in.
4. Click **Save** — Chrome prompts for permission to reach your app's
   origin; grant it (the extension only asks for the one origin you gave it,
   nothing broader).
5. Click **Test connection** to confirm the app is reachable and the token
   is valid.

## Usage

- **Toolbar button**: open a model page on MakerWorld, Thingiverse, or
  Printables, click the extension's toolbar icon, then **Save to my
  library**.
- **Right-click a link**: on any page, right-click a link to a model on one
  of those sites and choose **Save model to my library** from the context
  menu — no need to open the link first.

## Syncing your MakerWorld collections

MakerWorld blocks servers from listing your named collections (the SSR route
behind them is intermittently Cloudflare-walled from a server IP), so the
app can't enumerate your per-collection structure on its own — but your
browser, already signed in, can see it just fine. To hand that structure
over:

1. Open your MakerWorld collections page (`makerworld.com/@<your
   handle>/collections`).
2. Click the extension's toolbar icon.
3. Click **Sync collections to app**.

The app now knows each collection's name and id, so a collection you follow
by pasting its URL shows its real title instead of a generic placeholder.
Re-run the sync any time your collections change — each sync replaces the
app's cached list with what's on the page, so a deleted or renamed
collection updates too.

## The MakerWorld courier

While you're signed in and browsing makerworld.com, the extension watches
for your MakerWorld session cookie and, when it changes, pushes the new
value to the app so your followed MakerWorld collections keep syncing
without you ever opening DevTools.

**Honest caveat**: this only happens while your browser is running and you
visit makerworld.com. If the cookie fully expires during a long stretch with
the browser closed (or without a MakerWorld visit), syncing pauses until you
next sign in and browse to makerworld.com — the extension has no way to
refresh a cookie it can't see.

## Running the tests

```sh
node --test extension/test/*.test.js
```

Use the glob form above, not a bare `extension/test` directory — the
directory form is broken on Node 24.
