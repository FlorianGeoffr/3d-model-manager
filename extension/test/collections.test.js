import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildItemsFetchPlan,
  extractFavoritesList,
  extractHandle,
  mapDesignHits,
} from "../src/collections.js";

/** Wraps a `favoritesList` array in the shape of a real `__NEXT_DATA__`
 * script tag's parsed JSON (`{props: {pageProps: {favoritesList}}}`). */
function nextData(favoritesList) {
  return { props: { pageProps: { favoritesList } } };
}

test("extractFavoritesList: happy path -- maps visible collections, skips a hidden one (status !== 1)", () => {
  // Mirrors backend/tests/cassettes/makerworld_fixtures.py FAVORITES_LIST.
  const entries = extractFavoritesList(
    nextData([
      {
        id: 2155987,
        title: "Default Collection",
        slug: "default-collection",
        isDefault: true,
        designCnt: 7,
        status: 1,
      },
      {
        id: 18925823,
        title: "ESP32",
        slug: "esp32",
        isDefault: false,
        designCnt: 9,
        status: 1,
      },
      {
        id: 1793275,
        title: "Trays",
        slug: "trays",
        isDefault: false,
        designCnt: 3,
        status: 2, // hidden -- must be filtered out
      },
    ]),
  );

  assert.deepEqual(entries, [
    { list_id: "2155987", title: "Default Collection", slug: "default-collection", count: 7, is_default: true },
    { list_id: "18925823", title: "ESP32", slug: "esp32", count: 9, is_default: false },
  ]);
});

test("extractFavoritesList: missing __NEXT_DATA__/props/pageProps/favoritesList at any depth returns []", () => {
  assert.deepEqual(extractFavoritesList(null), []);
  assert.deepEqual(extractFavoritesList(undefined), []);
  assert.deepEqual(extractFavoritesList({}), []);
  assert.deepEqual(extractFavoritesList({ props: {} }), []);
  assert.deepEqual(extractFavoritesList({ props: { pageProps: {} } }), []);
  assert.deepEqual(extractFavoritesList({ props: { pageProps: { favoritesList: null } } }), []);
  assert.deepEqual(extractFavoritesList({ props: { pageProps: { favoritesList: "not an array" } } }), []);
});

test("extractFavoritesList: drops entries missing an id or a title", () => {
  const entries = extractFavoritesList(
    nextData([
      { title: "No id", status: 1 },
      { id: 42, status: 1 }, // no title
      { id: 0, title: "Falsy id", status: 1 }, // id 0 is falsy -- dropped like the backend's `if not cid`
      { id: 99, title: "Kept", status: 1 },
    ]),
  );

  assert.deepEqual(entries, [{ list_id: "99", title: "Kept", slug: null, count: null, is_default: false }]);
});

test("extractFavoritesList: defaults slug/count to null and is_default to false when absent", () => {
  const entries = extractFavoritesList(nextData([{ id: 5, title: "Bare", status: 1 }]));

  assert.deepEqual(entries, [{ list_id: "5", title: "Bare", slug: null, count: null, is_default: false }]);
});

test("extractHandle: falls back to the /@handle/collections URL path segment when __NEXT_DATA__ has no recognizable handle field", () => {
  const handle = extractHandle({}, "https://makerworld.com/en/@Terminalfoo/collections");
  assert.equal(handle, "Terminalfoo");
});

test("extractHandle: URL fallback works with a further path segment or query string", () => {
  assert.equal(
    extractHandle(null, "https://makerworld.com/@Terminalfoo/collections/2155987"),
    "Terminalfoo",
  );
  assert.equal(
    extractHandle(undefined, "https://makerworld.com/en/@Terminalfoo/collections?tab=all"),
    "Terminalfoo",
  );
});

test("extractHandle: an unparseable URL and no usable __NEXT_DATA__ returns null", () => {
  assert.equal(extractHandle({}, "not a url"), null);
  assert.equal(extractHandle({}, "https://makerworld.com/some/other/page"), null);
});

test("extractHandle: prefers a handle found in __NEXT_DATA__ over the URL", () => {
  const nextData = { props: { pageProps: { userInfo: { name: "FromNextData" } } } };
  assert.equal(
    extractHandle(nextData, "https://makerworld.com/en/@FromUrl/collections"),
    "FromNextData",
  );
});

test("buildItemsFetchPlan: empty collections array returns an empty plan", () => {
  assert.deepEqual(buildItemsFetchPlan([]), []);
});

test("buildItemsFetchPlan: happy path -- one page per collection when count <= pageSize", () => {
  const plan = buildItemsFetchPlan(
    [
      { list_id: "2155987", count: 7 },
      { list_id: "18925823", count: 9 },
    ],
    20,
  );

  assert.deepEqual(plan, [
    { listId: "2155987", offset: 0 },
    { listId: "18925823", offset: 0 },
  ]);
});

test("buildItemsFetchPlan: count > pageSize produces one descriptor per page, offsets stepping by pageSize", () => {
  const plan = buildItemsFetchPlan([{ list_id: "42", count: 45 }], 20);

  assert.deepEqual(plan, [
    { listId: "42", offset: 0 },
    { listId: "42", offset: 20 },
    { listId: "42", offset: 40 },
  ]);
});

test("buildItemsFetchPlan: caps a collection's coverage at 500 items regardless of a larger count", () => {
  const plan = buildItemsFetchPlan([{ list_id: "42", count: 10000 }], 20);

  assert.equal(plan.length, 25); // 500 / 20
  assert.deepEqual(plan[0], { listId: "42", offset: 0 });
  assert.deepEqual(plan[24], { listId: "42", offset: 480 });
});

test("buildItemsFetchPlan: a null/absent count still yields exactly one page (offset 0)", () => {
  const plan = buildItemsFetchPlan(
    [
      { list_id: "1", count: null },
      { list_id: "2" },
      { list_id: "3", count: 0 },
    ],
    20,
  );

  assert.deepEqual(plan, [
    { listId: "1", offset: 0 },
    { listId: "2", offset: 0 },
    { listId: "3", offset: 0 },
  ]);
});

test("buildItemsFetchPlan: entries missing a list_id are skipped", () => {
  assert.deepEqual(buildItemsFetchPlan([null, {}, { count: 5 }]), []);
});

test("mapDesignHits: happy path -- maps hits to push entries", () => {
  // Mirrors backend/tests/cassettes/makerworld_fixtures.py FAVORITE_DESIGNS.
  const items = mapDesignHits({
    hits: [
      {
        id: 2188414,
        title: "ESP32-C6-Zigbee Gehäuse",
        cover: "https://makerworld.bblmw.com/cover1.jpg",
        designCreator: { uid: 3279776322, name: "Jackstyle" },
      },
      {
        id: 2603954,
        title: "Housing for ESP32-C6 DevKitC",
        cover: "https://makerworld.bblmw.com/cover2.jpg",
        designCreator: { uid: 4268272778, name: "Javier Lorenzana" },
      },
    ],
    total: 2,
  });

  assert.deepEqual(items, [
    {
      external_id: "2188414",
      title: "ESP32-C6-Zigbee Gehäuse",
      url: "https://makerworld.com/en/models/2188414",
      author: "Jackstyle",
      thumbnail_url: "https://makerworld.bblmw.com/cover1.jpg",
    },
    {
      external_id: "2603954",
      title: "Housing for ESP32-C6 DevKitC",
      url: "https://makerworld.com/en/models/2603954",
      author: "Javier Lorenzana",
      thumbnail_url: "https://makerworld.bblmw.com/cover2.jpg",
    },
  ]);
});

test("mapDesignHits: missing/malformed hits at any depth returns []", () => {
  assert.deepEqual(mapDesignHits(null), []);
  assert.deepEqual(mapDesignHits(undefined), []);
  assert.deepEqual(mapDesignHits({}), []);
  assert.deepEqual(mapDesignHits({ hits: null }), []);
  assert.deepEqual(mapDesignHits({ hits: "not an array" }), []);
  assert.deepEqual(mapDesignHits({ hits: [] }), []);
});

test("mapDesignHits: drops entries missing an id or a title, defaults absent author/cover to null", () => {
  const items = mapDesignHits({
    hits: [
      { title: "No id" },
      { id: 42 }, // no title
      { id: 0, title: "Falsy id" }, // id 0 is falsy -- dropped
      { id: 99, title: "Kept, no creator or cover" },
    ],
  });

  assert.deepEqual(items, [
    {
      external_id: "99",
      title: "Kept, no creator or cover",
      url: "https://makerworld.com/en/models/99",
      author: null,
      thumbnail_url: null,
    },
  ]);
});
