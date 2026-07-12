import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildItemsFetchPlan,
  extractFavoritesListFrom,
  extractHandle,
  findDesignListIn,
  hasFavoritesList,
  mapDesignHits,
} from "../src/collections.js";

/** Wraps a `favoritesList` array in the shape of a real `__NEXT_DATA__`
 * script tag's parsed JSON (`{props: {pageProps: {favoritesList}}}`). */
function nextData(favoritesList) {
  return { props: { pageProps: { favoritesList } } };
}

test("extractFavoritesListFrom: happy path -- maps ALL collections regardless of status, including private ones", () => {
  // Mirrors backend/tests/cassettes/makerworld_fixtures.py FAVORITES_LIST.
  // Unlike the backend's own SSR-scrape importer (which only ever sees
  // public collections), this is the user's OWN account syncing to their
  // OWN library manager -- private collections (status !== 1) must sync
  // too (live bug report: the user's collections are mostly private, and
  // the old status===1 filter dropped nearly all of them).
  const entries = extractFavoritesListFrom(
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
        status: 2, // private -- INCLUDED now (F1 fix)
      },
    ]),
  );

  assert.deepEqual(entries, [
    { list_id: "2155987", title: "Default Collection", slug: "default-collection", count: 7, is_default: true },
    { list_id: "18925823", title: "ESP32", slug: "esp32", count: 9, is_default: false },
    { list_id: "1793275", title: "Trays", slug: "trays", count: 3, is_default: false },
  ]);
});

test("extractFavoritesListFrom: missing __NEXT_DATA__/props/pageProps/favoritesList at any depth returns []", () => {
  assert.deepEqual(extractFavoritesListFrom(null), []);
  assert.deepEqual(extractFavoritesListFrom(undefined), []);
  assert.deepEqual(extractFavoritesListFrom({}), []);
  assert.deepEqual(extractFavoritesListFrom({ props: {} }), []);
  assert.deepEqual(extractFavoritesListFrom({ props: { pageProps: {} } }), []);
  assert.deepEqual(extractFavoritesListFrom({ props: { pageProps: { favoritesList: null } } }), []);
  assert.deepEqual(
    extractFavoritesListFrom({ props: { pageProps: { favoritesList: "not an array" } } }),
    [],
  );
});

test("extractFavoritesListFrom: drops entries missing an id or a title", () => {
  const entries = extractFavoritesListFrom(
    nextData([
      { title: "No id", status: 1 },
      { id: 42, status: 1 }, // no title
      { id: 0, title: "Falsy id", status: 1 }, // id 0 is falsy -- dropped like the backend's `if not cid`
      { id: 99, title: "Kept", status: 1 },
    ]),
  );

  assert.deepEqual(entries, [{ list_id: "99", title: "Kept", slug: null, count: null, is_default: false }]);
});

test("extractFavoritesListFrom: defaults slug/count to null and is_default to false when absent", () => {
  const entries = extractFavoritesListFrom(nextData([{ id: 5, title: "Bare", status: 1 }]));

  assert.deepEqual(entries, [{ list_id: "5", title: "Bare", slug: null, count: null, is_default: false }]);
});

test("extractFavoritesListFrom: accepts the data-route shape too -- pageProps passed directly, not wrapped in props", () => {
  const entries = extractFavoritesListFrom({ favoritesList: [{ id: 5, title: "Bare", status: 2 }] });
  assert.deepEqual(entries, [{ list_id: "5", title: "Bare", slug: null, count: null, is_default: false }]);
});

test("hasFavoritesList: true when a favoritesList array is present (inline or route shape), even when empty", () => {
  assert.equal(hasFavoritesList(nextData([])), true);
  assert.equal(hasFavoritesList({ favoritesList: [] }), true);
  assert.equal(hasFavoritesList(nextData([{ id: 1, title: "A", status: 1 }])), true);
});

test("hasFavoritesList: false when favoritesList is missing/malformed at any depth", () => {
  assert.equal(hasFavoritesList(null), false);
  assert.equal(hasFavoritesList(undefined), false);
  assert.equal(hasFavoritesList({}), false);
  assert.equal(hasFavoritesList({ props: {} }), false);
  assert.equal(hasFavoritesList({ favoritesList: "not an array" }), false);
});

test("extractHandle: reads the handle from the /@handle/collections URL path segment when __NEXT_DATA__ has no recognizable handle field", () => {
  const handle = extractHandle({}, "https://makerworld.com/en/@Terminalfoo/collections");
  assert.equal(handle, "Terminalfoo");
});

test("extractHandle: URL parsing works with a further path segment or query string", () => {
  assert.equal(
    extractHandle(null, "https://makerworld.com/@Terminalfoo/collections/2155987"),
    "Terminalfoo",
  );
  assert.equal(
    extractHandle(undefined, "https://makerworld.com/en/@Terminalfoo/collections?tab=all"),
    "Terminalfoo",
  );
});

test("extractHandle: prefers the URL's /@handle/collections segment over any __NEXT_DATA__ guess (F2 fix -- the URL is the guaranteed-reliable source, isCollectionsPage already required this path shape; __NEXT_DATA__ handle fields are unverified guesses)", () => {
  const nextData = { props: { pageProps: { userInfo: { name: "FromNextData" } } } };
  assert.equal(
    extractHandle(nextData, "https://makerworld.com/en/@FromUrl/collections"),
    "FromUrl",
  );
});

test("extractHandle: falls back to __NEXT_DATA__ only when the URL can't be parsed", () => {
  const nextData = { props: { pageProps: { userInfo: { name: "FromNextData" } } } };
  assert.equal(extractHandle(nextData, "not a url"), "FromNextData");
});

test("extractHandle: falls back to __NEXT_DATA__ when the URL parses but doesn't match the /@handle/collections shape", () => {
  const nextData = { props: { pageProps: { profile: { name: "FromNextData" } } } };
  assert.equal(
    extractHandle(nextData, "https://makerworld.com/some/other/page"),
    "FromNextData",
  );
});

test("extractHandle: an unparseable URL and no usable __NEXT_DATA__ returns null", () => {
  assert.equal(extractHandle({}, "not a url"), null);
  assert.equal(extractHandle({}, "https://makerworld.com/some/other/page"), null);
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

// findDesignListIn: tolerant discovery of a collection page's own
// design-list array (M10 Workstream, live-bug fix -- the field name
// carrying a named collection's items on its SSR data route wasn't
// captured live, since the old /api/v1 endpoint this replaces as the
// PRIMARY item source produced zero items on a real sync).

test("findDesignListIn: matches a known key ('designs') directly, no deep-scan needed", () => {
  const found = findDesignListIn({
    designs: [{ id: 1, title: "Item A" }, { id: 2, title: "Item B" }],
    unrelated: "noise",
  });
  assert.deepEqual(found, {
    key: "designs",
    designs: [{ id: 1, title: "Item A" }, { id: 2, title: "Item B" }],
  });
});

test("findDesignListIn: matches other known keys ('favoritesDesigns', 'list') in priority order", () => {
  assert.deepEqual(findDesignListIn({ favoritesDesigns: [{ id: 1, title: "A" }] }), {
    key: "favoritesDesigns",
    designs: [{ id: 1, title: "A" }],
  });
  assert.deepEqual(findDesignListIn({ list: [{ id: 1, name: "A" }] }), {
    key: "list",
    designs: [{ id: 1, name: "A" }],
  });
});

test("findDesignListIn: a known key with an empty array is still trusted (a genuinely-empty collection)", () => {
  assert.deepEqual(findDesignListIn({ designs: [] }), { key: "designs", designs: [] });
});

test("findDesignListIn: a known key whose array doesn't look design-shaped is skipped in favor of a later match", () => {
  const found = findDesignListIn({
    designs: ["not", "design", "shaped"],
    favoritesDesigns: [{ id: 1, title: "Real design" }],
  });
  assert.deepEqual(found, { key: "favoritesDesigns", designs: [{ id: 1, title: "Real design" }] });
});

test("findDesignListIn: deep-scan fallback -- a non-empty array of design-shaped objects under an unrecognized top-level key", () => {
  const found = findDesignListIn({
    someUnrecognizedField: [{ id: 42, title: "Found via deep-scan" }],
  });
  assert.deepEqual(found, {
    key: "someUnrecognizedField",
    designs: [{ id: 42, title: "Found via deep-scan" }],
  });
});

test("findDesignListIn: deep-scan fallback also looks one level into a nested plain object", () => {
  const found = findDesignListIn({
    result: { items: [{ id: 7, name: "Nested design" }] },
  });
  assert.deepEqual(found, { key: "result.items", designs: [{ id: 7, name: "Nested design" }] });
});

test("findDesignListIn: deep-scan requires shape validation AND non-emptiness -- an empty or non-design array under an unknown key is never trusted", () => {
  assert.equal(findDesignListIn({ someField: [] }), null);
  assert.equal(findDesignListIn({ someField: ["not", "designs"] }), null);
  assert.equal(findDesignListIn({ someField: [{ id: "not-a-number", title: "A" }] }), null);
  assert.equal(findDesignListIn({ someField: [{ id: 1 }] }), null); // no title/name
});

test("findDesignListIn: no match anywhere (named keys or deep-scan) returns null", () => {
  assert.equal(findDesignListIn({}), null);
  assert.equal(findDesignListIn(null), null);
  assert.equal(findDesignListIn(undefined), null);
  assert.equal(findDesignListIn({ unrelated: "noise", other: 42 }), null);
});
