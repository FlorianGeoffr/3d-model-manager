import { test } from "node:test";
import assert from "node:assert/strict";

import { extractFavoritesList } from "../src/collections.js";

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
