import { test } from "node:test";
import assert from "node:assert/strict";

import { detectSite, isModelPage } from "../src/detect.js";

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
