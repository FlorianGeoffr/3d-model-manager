import { test } from "node:test";
import assert from "node:assert/strict";

import { detectSite, isCollectionDetailPage, isCollectionsPage, isModelPage } from "../src/detect.js";

test("detectSite: identifies each supported gallery host", () => {
  assert.equal(detectSite("https://makerworld.com/en/models/643408-foo"), "makerworld");
  assert.equal(detectSite("https://www.makerworld.com/en/models/643408-foo"), "makerworld");
  assert.equal(detectSite("https://www.thingiverse.com/thing:4990415"), "thingiverse");
  assert.equal(detectSite("https://thingiverse.com/thing:4990415"), "thingiverse");
  assert.equal(detectSite("https://www.printables.com/model/12345-foo"), "printables");
  assert.equal(detectSite("https://printables.com/model/12345-foo"), "printables");
});

test("detectSite: returns null for unsupported hosts", () => {
  assert.equal(detectSite("https://example.com/models/123"), null);
  assert.equal(detectSite("https://cults3d.com/en/3d-model/thing"), null);
});

test("detectSite: never throws on a malformed URL", () => {
  assert.doesNotThrow(() => detectSite("not a url"));
  assert.equal(detectSite("not a url"), null);
  assert.equal(detectSite(""), null);
});

test("isModelPage: true for a real model URL on each site", () => {
  assert.equal(isModelPage("https://makerworld.com/en/models/643408-foo"), true);
  assert.equal(isModelPage("https://www.makerworld.com/de/models/643408"), true);
  assert.equal(isModelPage("https://www.thingiverse.com/thing:4990415"), true);
  assert.equal(isModelPage("https://www.thingiverse.com/make:4990415?thing=4990415"), true);
  assert.equal(isModelPage("https://example.com/?foo=thing=4990415"), false); // wrong host
  assert.equal(isModelPage("https://www.printables.com/model/12345-foo"), true);
  assert.equal(isModelPage("https://printables.com/model/12345"), true);
});

test("isModelPage: false for a non-model page on a supported host", () => {
  assert.equal(isModelPage("https://makerworld.com/en"), false);
  assert.equal(isModelPage("https://www.makerworld.com/en/search?keyword=vase"), false);
  assert.equal(isModelPage("https://www.thingiverse.com/search?q=vase"), false);
  assert.equal(isModelPage("https://www.thingiverse.com/explore/popular"), false);
  assert.equal(isModelPage("https://www.printables.com/model"), false);
  assert.equal(isModelPage("https://www.printables.com/search/models?q=vase"), false);
});

test("isModelPage: false for an unsupported host", () => {
  assert.equal(isModelPage("https://example.com/models/643408"), false);
  assert.equal(isModelPage("https://cults3d.com/en/3d-model/thing/643408"), false);
});

test("isModelPage: never throws on a malformed URL", () => {
  assert.doesNotThrow(() => isModelPage("not a url"));
  assert.equal(isModelPage("not a url"), false);
  assert.equal(isModelPage(""), false);
  assert.equal(isModelPage(undefined), false);
});

test("isCollectionsPage: true for a MakerWorld user's collections page, with/without a locale prefix or www", () => {
  assert.equal(isCollectionsPage("https://makerworld.com/@Terminalfoo/collections"), true);
  assert.equal(isCollectionsPage("https://www.makerworld.com/@Terminalfoo/collections"), true);
  assert.equal(isCollectionsPage("https://makerworld.com/en/@Terminalfoo/collections"), true);
  assert.equal(isCollectionsPage("https://www.makerworld.com/en/@Terminalfoo/collections"), true);
});

test("isCollectionsPage: true with a trailing slash, trailing segment, or query string", () => {
  assert.equal(isCollectionsPage("https://makerworld.com/@Terminalfoo/collections/"), true);
  assert.equal(isCollectionsPage("https://makerworld.com/en/@Terminalfoo/collections/"), true);
  assert.equal(isCollectionsPage("https://makerworld.com/@Terminalfoo/collections/1793275-trays"), true);
  assert.equal(isCollectionsPage("https://makerworld.com/en/@Terminalfoo/collections?tab=likes"), true);
});

test("isCollectionsPage: false for a model page on the same host", () => {
  assert.equal(isCollectionsPage("https://makerworld.com/en/models/643408-foo"), false);
  assert.equal(isCollectionsPage("https://www.makerworld.com/models/643408-foo"), false);
});

test("isCollectionsPage: false for a MakerWorld page that isn't a collections page", () => {
  assert.equal(isCollectionsPage("https://makerworld.com/@Terminalfoo"), false);
  assert.equal(isCollectionsPage("https://makerworld.com/en/search?keyword=vase"), false);
});

test("isCollectionsPage: false for an unsupported host", () => {
  assert.equal(isCollectionsPage("https://example.com/@Terminalfoo/collections"), false);
  assert.equal(isCollectionsPage("https://www.thingiverse.com/@Terminalfoo/collections"), false);
});

test("isCollectionsPage: never throws on a malformed URL", () => {
  assert.doesNotThrow(() => isCollectionsPage("not a url"));
  assert.equal(isCollectionsPage("not a url"), false);
  assert.equal(isCollectionsPage(""), false);
  assert.equal(isCollectionsPage(undefined), false);
});

// isCollectionDetailPage (M11): ground-truth shape captured from a real
// logged-in browser -- `https://makerworld.com/en/collections/18925823-esp32`
// (locale-prefixed, plural "collections", NO `@handle` segment, numeric id,
// optional `-slug` suffix). An entirely different route from the LIST page
// (`isCollectionsPage` above, `/@handle/collections`).

test("isCollectionDetailPage: true for the real ground-truth URL", () => {
  assert.equal(isCollectionDetailPage("https://makerworld.com/en/collections/18925823-esp32"), true);
});

test("isCollectionDetailPage: true with/without a locale prefix, www, slug, or trailing slash", () => {
  assert.equal(isCollectionDetailPage("https://makerworld.com/collections/18925823"), true);
  assert.equal(isCollectionDetailPage("https://www.makerworld.com/collections/18925823-esp32"), true);
  assert.equal(isCollectionDetailPage("https://makerworld.com/en-us/collections/18925823-esp32"), true);
  assert.equal(isCollectionDetailPage("https://makerworld.com/en/collections/18925823-esp32/"), true);
  assert.equal(isCollectionDetailPage("https://makerworld.com/collections/18925823/"), true);
});

test("isCollectionDetailPage: true for the singular '/collection/<id>' spelling too", () => {
  assert.equal(isCollectionDetailPage("https://makerworld.com/en/collection/18925823-esp32"), true);
});

test("isCollectionDetailPage: false for the collections LIST/index page (/@handle/collections), with or without a trailing id-looking segment", () => {
  assert.equal(isCollectionDetailPage("https://makerworld.com/en/@Terminalfoo/collections"), false);
  assert.equal(
    isCollectionDetailPage("https://makerworld.com/en/@Terminalfoo/collections/18925823"),
    false,
  );
});

test("isCollectionDetailPage: false for a bare /collections with no numeric id", () => {
  assert.equal(isCollectionDetailPage("https://makerworld.com/en/collections"), false);
  assert.equal(isCollectionDetailPage("https://makerworld.com/collections/"), false);
});

test("isCollectionDetailPage: false for a model page or other MakerWorld page", () => {
  assert.equal(isCollectionDetailPage("https://makerworld.com/en/models/643408-foo"), false);
  assert.equal(isCollectionDetailPage("https://makerworld.com/en/search?keyword=vase"), false);
});

test("isCollectionDetailPage: false for an unsupported host", () => {
  assert.equal(isCollectionDetailPage("https://example.com/collections/18925823-esp32"), false);
  assert.equal(isCollectionDetailPage("https://www.thingiverse.com/collections/18925823-esp32"), false);
});

test("isCollectionDetailPage: never throws on a malformed URL", () => {
  assert.doesNotThrow(() => isCollectionDetailPage("not a url"));
  assert.equal(isCollectionDetailPage("not a url"), false);
  assert.equal(isCollectionDetailPage(""), false);
  assert.equal(isCollectionDetailPage(undefined), false);
});
