import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hashCollectionsPayload,
  readCollectionsPage,
  shouldPersistHash,
  shouldPushCollections,
  syncCollections,
} from "../src/syncFlow.js";
import { hashToken } from "../src/courier.js";

const BUILD_ID = "build-abc123";
const COLLECTIONS_URL = "https://makerworld.com/en/@Terminalfoo/collections";
const COLLECTIONS_PATHNAME = "/en/@Terminalfoo/collections";

// Mirrors backend/tests/cassettes/makerworld_fixtures.py FAVORITES_LIST /
// test/collections.test.js's fixtures -- two collections. Carries a
// `buildId` (needed for the data-route reads `readCollectionsDataInPage`/
// `readCollectionItemsFromDataRoute` build) unless a test explicitly needs
// to exercise the no-buildId path.
const NEXT_DATA = {
  buildId: BUILD_ID,
  props: {
    pageProps: {
      favoritesList: [
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
      ],
    },
  },
};

const ENTRIES = [
  {
    list_id: "2155987",
    title: "Default Collection",
    slug: "default-collection",
    count: 7,
    is_default: true,
  },
  { list_id: "18925823", title: "ESP32", slug: "esp32", count: 9, is_default: false },
];

/** A `NEXT_DATA`-shaped fixture carrying only the first collection, for
 * tests that want a single-collection item pipeline in isolation. */
const ONE_ENTRY_NEXT_DATA = {
  buildId: BUILD_ID,
  props: { pageProps: { favoritesList: [NEXT_DATA.props.pageProps.favoritesList[0]] } },
};

/** Records calls and returns queued results/throws in call order. */
function stubExec(steps) {
  let i = 0;
  const calls = [];
  const exec = async (tabId, func, args) => {
    const step = steps[i++];
    calls.push({ tabId, func, args });
    if (!step) {
      throw new Error(`stubExec: no step queued for call #${i}`);
    }
    if (step.throws) {
      throw new Error(step.throws);
    }
    return step.result;
  };
  return { exec, calls };
}

/** A queued `stubExec` step for the page-read exec call --
 * `readCollectionsDataInPage`'s `{nextData, routePageProps}` shape. */
function pageResult({ nextData = null, routePageProps = null } = {}) {
  return { result: { nextData, routePageProps } };
}

/** A queued `stubExec` step for a per-collection PRIMARY data-route exec
 * call -- `fetchCollectionDataRouteInPage`'s raw route JSON
 * (`{pageProps, ...}`) shape. */
function designsRoute(pageProps) {
  return { result: { pageProps } };
}

function okResult(data = { ok: true }) {
  return { ok: true, status: 200, data, error: null };
}

function errResult(error, status = 422) {
  return { ok: false, status, data: null, error };
}

function stubApi({ pushCollections, pushCollectionItems } = {}) {
  const calls = { pushCollections: [], pushCollectionItems: [] };
  return {
    calls,
    api: {
      pushCollections: async (site, collections) => {
        calls.pushCollections.push({ site, collections });
        return pushCollections ?? okResult({ ok: true, count: collections.length });
      },
      pushCollectionItems: async (site, listId, items) => {
        const index = calls.pushCollectionItems.length;
        calls.pushCollectionItems.push({ site, listId, items });
        const configured = Array.isArray(pushCollectionItems)
          ? pushCollectionItems[index]
          : pushCollectionItems;
        return configured ?? okResult({ ok: true, count: items.length });
      },
    },
  };
}

function stubReport() {
  const calls = [];
  return { report: (text, kind) => calls.push({ text, kind }), calls };
}

test("syncCollections: happy path -- pushes the list, reads+pushes each collection's items via the primary data route, returns the summary", async () => {
  const { exec, calls: execCalls } = stubExec([
    pageResult({ nextData: NEXT_DATA }),
    designsRoute({ designs: [{ id: 1, title: "Item A" }] }),
    designsRoute({ designs: [{ id: 2, title: "Item B" }] }),
  ]);
  const { api, calls: apiCalls } = stubApi();
  const { report, calls: reportCalls } = stubReport();

  const summary = await syncCollections({
    tabId: 7,
    url: COLLECTIONS_URL,
    exec,
    api,
    report,
  });

  assert.deepEqual(summary, { collections: 2, items: 2, unreadable: [] });
  assert.deepEqual(apiCalls.pushCollections[0], { site: "makerworld", collections: ENTRIES });
  assert.equal(apiCalls.pushCollectionItems.length, 2);
  assert.equal(apiCalls.pushCollectionItems[0].listId, "2155987");
  assert.deepEqual(apiCalls.pushCollectionItems[0].items, [
    {
      external_id: "1",
      title: "Item A",
      url: "https://makerworld.com/en/models/1",
      author: null,
      thumbnail_url: null,
    },
  ]);
  assert.equal(apiCalls.pushCollectionItems[1].listId, "18925823");
  // Page read + one primary data-route fetch per collection -- no fallback
  // calls needed since the primary source succeeded for both.
  assert.equal(execCalls.length, 3);
  assert.deepEqual(execCalls[1].args, [BUILD_ID, `${COLLECTIONS_PATHNAME}/2155987`]);
  assert.deepEqual(execCalls[2].args, [BUILD_ID, `${COLLECTIONS_PATHNAME}/18925823`]);
  const last = reportCalls[reportCalls.length - 1];
  assert.equal(last.text, "Synced 2 collections (2 items).");
  assert.equal(last.kind, "ok");
});

test("syncCollections: route+inline both unreadable reports the hard-refresh message and pushes nothing", async () => {
  // Neither the data route nor the inline __NEXT_DATA__ carried a
  // favoritesList array at all -- the stale-snapshot/unreachable-route
  // failure mode from the live bug report, distinct from a genuinely-empty
  // account (next test).
  const { exec } = stubExec([pageResult({ nextData: null, routePageProps: null })]);
  const { api, calls: apiCalls } = stubApi();
  const { report, calls: reportCalls } = stubReport();

  await assert.rejects(
    syncCollections({ tabId: 7, url: COLLECTIONS_URL, exec, api, report }),
    /Couldn't read your collections from this page/,
  );

  assert.equal(apiCalls.pushCollections.length, 0);
  assert.equal(apiCalls.pushCollectionItems.length, 0);
  assert.deepEqual(reportCalls[reportCalls.length - 1], {
    text: "Couldn't read your collections from this page — try a hard refresh (Ctrl+Shift+R) and click again.",
    kind: "error",
  });
});

test("syncCollections: a favoritesList array WAS found but is genuinely empty reports the empty-account message", async () => {
  const { exec } = stubExec([
    pageResult({ nextData: { props: { pageProps: { favoritesList: [] } } } }),
  ]);
  const { api, calls: apiCalls } = stubApi();
  const { report, calls: reportCalls } = stubReport();

  await assert.rejects(
    syncCollections({ tabId: 7, url: COLLECTIONS_URL, exec, api, report }),
    /No collections in your MakerWorld account yet\./,
  );

  assert.equal(apiCalls.pushCollections.length, 0);
  assert.equal(apiCalls.pushCollectionItems.length, 0);
  assert.deepEqual(reportCalls[reportCalls.length - 1], {
    text: "No collections in your MakerWorld account yet.",
    kind: "error",
  });
});

test("syncCollections: a collection unreadable from BOTH sources is skipped and listed; a collection whose primary source succeeds never calls the fallback", async () => {
  const { exec, calls: execCalls } = stubExec([
    pageResult({ nextData: NEXT_DATA }),
    { throws: "data route unreachable" }, // collection 1 primary throws
    { result: [{ hits: [], total: 0 }] }, // collection 1 fallback: empty
    designsRoute({ designs: [{ id: 2, title: "Item B" }] }), // collection 2 primary succeeds
  ]);
  const { api, calls: apiCalls } = stubApi();
  const { report, calls: reportCalls } = stubReport();

  const summary = await syncCollections({ tabId: 7, url: COLLECTIONS_URL, exec, api, report });

  assert.deepEqual(summary, {
    collections: 2,
    items: 1,
    unreadable: ["Default Collection"],
  });
  // Only the readable collection's items were pushed.
  assert.equal(apiCalls.pushCollectionItems.length, 1);
  assert.equal(apiCalls.pushCollectionItems[0].listId, "18925823");
  assert.equal(execCalls.length, 4); // page + (primary throw + fallback) + primary-only
  const last = reportCalls[reportCalls.length - 1];
  assert.equal(last.text, "Synced 2 collections (1 items; 1 collection unreadable).");
  assert.equal(last.kind, "ok");
});

test("syncCollections: a collection whose item push is rejected is also listed as unreadable", async () => {
  const { exec } = stubExec([
    pageResult({ nextData: NEXT_DATA }),
    designsRoute({ designs: [{ id: 1, title: "Item A" }] }),
    designsRoute({ designs: [{ id: 2, title: "Item B" }] }),
  ]);
  const { api, calls: apiCalls } = stubApi({
    pushCollectionItems: [errResult("collection not found"), undefined],
  });
  const { report } = stubReport();

  const summary = await syncCollections({ tabId: 7, url: COLLECTIONS_URL, exec, api, report });

  assert.deepEqual(summary, { collections: 2, items: 1, unreadable: ["Default Collection"] });
  assert.equal(apiCalls.pushCollectionItems.length, 2);
});

test("syncCollections: items still sync via the handle-free primary source even when the URL has no /@handle/collections shape", async () => {
  // extractHandle returns null here (URL doesn't match /@handle/collections,
  // NEXT_DATA has no recognizable handle field) -- the primary data-route
  // source doesn't need a handle at all, only buildId + the collections
  // pathname, both independent of the handle.
  const OTHER_URL = "https://makerworld.com/some/other/page";
  const { exec, calls: execCalls } = stubExec([
    pageResult({ nextData: NEXT_DATA }),
    designsRoute({ designs: [{ id: 1, title: "Item A" }] }),
    designsRoute({ designs: [{ id: 2, title: "Item B" }] }),
  ]);
  const { api, calls: apiCalls } = stubApi();
  const { report, calls: reportCalls } = stubReport();

  const summary = await syncCollections({ tabId: 7, url: OTHER_URL, exec, api, report });

  assert.deepEqual(summary, { collections: 2, items: 2, unreadable: [] });
  assert.equal(apiCalls.pushCollectionItems.length, 2);
  assert.equal(execCalls.length, 3); // no fallback calls -- a handle was never needed
  assert.deepEqual(execCalls[1].args, [BUILD_ID, "/some/other/page/2155987"]);
  assert.equal(reportCalls[reportCalls.length - 1].text, "Synced 2 collections (2 items).");
});

test("syncCollections: no buildId (primary skipped) and no handle (fallback skipped) leaves every collection unreadable but still succeeds with a truthful count", async () => {
  const NEXT_DATA_NO_BUILD = {
    props: { pageProps: { favoritesList: NEXT_DATA.props.pageProps.favoritesList } },
  };
  const OTHER_URL = "https://makerworld.com/some/other/page";
  const { exec, calls: execCalls } = stubExec([pageResult({ nextData: NEXT_DATA_NO_BUILD })]);
  const { api, calls: apiCalls } = stubApi();
  const { report, calls: reportCalls } = stubReport();

  const summary = await syncCollections({ tabId: 7, url: OTHER_URL, exec, api, report });

  assert.deepEqual(summary, {
    collections: 2,
    items: 0,
    unreadable: ["Default Collection", "ESP32"],
  });
  assert.equal(apiCalls.pushCollections.length, 1);
  assert.equal(apiCalls.pushCollectionItems.length, 0);
  // Only the page read -- no buildId and no handle means no per-collection
  // exec call was even attempted.
  assert.equal(execCalls.length, 1);
  assert.equal(
    reportCalls[reportCalls.length - 1].text,
    "Synced 2 collections (0 items; 2 collections unreadable).",
  );
});

test("syncCollections: an unreadable page reports and rejects with 'Couldn't read this page.', no pushes", async () => {
  const { exec } = stubExec([{ throws: "executeScript failed" }]);
  const { api, calls: apiCalls } = stubApi();
  const { report, calls: reportCalls } = stubReport();

  await assert.rejects(
    syncCollections({ tabId: 7, url: COLLECTIONS_URL, exec, api, report }),
    /Couldn't read this page\./,
  );

  assert.equal(apiCalls.pushCollections.length, 0);
  assert.deepEqual(reportCalls[reportCalls.length - 1], {
    text: "Couldn't read this page.",
    kind: "error",
  });
});

test("syncCollections: a rejected list push reports the server's error and rejects, no item fetches", async () => {
  const { exec, calls: execCalls } = stubExec([pageResult({ nextData: NEXT_DATA })]);
  const { api } = stubApi({ pushCollections: errResult("collections: at most 200 entries") });
  const { report, calls: reportCalls } = stubReport();

  await assert.rejects(
    syncCollections({ tabId: 7, url: COLLECTIONS_URL, exec, api, report }),
    /collections: at most 200 entries/,
  );

  assert.equal(execCalls.length, 1); // only the page read -- no item fetches
  assert.deepEqual(reportCalls[reportCalls.length - 1], {
    text: "collections: at most 200 entries",
    kind: "error",
  });
});

test("syncCollections: a rejected list push with no error text falls back to a generic message", async () => {
  const { exec } = stubExec([pageResult({ nextData: NEXT_DATA })]);
  const { api } = stubApi({ pushCollections: { ok: false, status: 500, data: null, error: "" } });
  const { report, calls: reportCalls } = stubReport();

  await assert.rejects(
    syncCollections({ tabId: 7, url: COLLECTIONS_URL, exec, api, report }),
    /Something went wrong\./,
  );
  assert.equal(reportCalls[reportCalls.length - 1].text, "Something went wrong.");
});

test("syncCollections: an injected `page` skips the module's own page read entirely", async () => {
  const { exec, calls: execCalls } = stubExec([
    designsRoute({ designs: [{ id: 1, title: "Item A" }] }),
    designsRoute({ designs: [{ id: 2, title: "Item B" }] }),
  ]);
  const { api, calls: apiCalls } = stubApi();
  const { report } = stubReport();

  const summary = await syncCollections({
    tabId: 7,
    url: COLLECTIONS_URL,
    exec,
    api,
    report,
    page: { nextData: NEXT_DATA, entries: ENTRIES, found: true },
  });

  assert.deepEqual(summary, { collections: 2, items: 2, unreadable: [] });
  // Only the two primary item-fetch exec calls -- no exec call for the page
  // read itself.
  assert.equal(execCalls.length, 2);
  assert.deepEqual(apiCalls.pushCollections[0].collections, ENTRIES);
});

test("syncCollections item-source preference: the primary data route is preferred and the api fallback is never called when it yields designs", async () => {
  const { exec, calls: execCalls } = stubExec([
    pageResult({ nextData: ONE_ENTRY_NEXT_DATA }),
    designsRoute({ designs: [{ id: 1, title: "Item A" }] }),
    // No third step queued -- if the code also called the api fallback,
    // stubExec would throw "no step queued" and fail this test.
  ]);
  const { api, calls: apiCalls } = stubApi();
  const { report } = stubReport();

  const summary = await syncCollections({ tabId: 7, url: COLLECTIONS_URL, exec, api, report });

  assert.deepEqual(summary, { collections: 1, items: 1, unreadable: [] });
  assert.equal(execCalls.length, 2);
  assert.equal(apiCalls.pushCollectionItems[0].items.length, 1);
});

test("syncCollections item-source preference: an empty/404 primary route falls back to the api endpoint", async () => {
  const { exec, calls: execCalls } = stubExec([
    pageResult({ nextData: ONE_ENTRY_NEXT_DATA }),
    { result: null }, // primary route 404s/parses empty -- fetchCollectionDataRouteInPage returns null
    { result: [{ hits: [{ id: 9, title: "Fallback Item" }], total: 1 }] }, // api fallback
  ]);
  const { api, calls: apiCalls } = stubApi();
  const { report } = stubReport();

  const summary = await syncCollections({ tabId: 7, url: COLLECTIONS_URL, exec, api, report });

  assert.deepEqual(summary, { collections: 1, items: 1, unreadable: [] });
  assert.equal(execCalls.length, 3);
  assert.deepEqual(apiCalls.pushCollectionItems[0].items, [
    {
      external_id: "9",
      title: "Fallback Item",
      url: "https://makerworld.com/en/models/9",
      author: null,
      thumbnail_url: null,
    },
  ]);
});

test("syncCollections item-source preference: both sources empty leaves the collection unreadable with nothing pushed for it", async () => {
  const { exec } = stubExec([
    pageResult({ nextData: ONE_ENTRY_NEXT_DATA }),
    { result: null }, // primary empty/404
    { result: [{ hits: [], total: 0 }] }, // fallback empty
  ]);
  const { api, calls: apiCalls } = stubApi();
  const { report } = stubReport();

  const summary = await syncCollections({ tabId: 7, url: COLLECTIONS_URL, exec, api, report });

  assert.deepEqual(summary, { collections: 1, items: 0, unreadable: ["Default Collection"] });
  assert.equal(apiCalls.pushCollectionItems.length, 0);
});

test("syncCollections: primary item source tolerates a deep-scan-discovered design array under an unrecognized key, normalizing 'name' to 'title'", async () => {
  const { exec } = stubExec([
    pageResult({ nextData: ONE_ENTRY_NEXT_DATA }),
    designsRoute({ weirdKey: [{ id: 77, name: "Deep Item" }] }),
  ]);
  const { api, calls: apiCalls } = stubApi();
  const { report, calls: reportCalls } = stubReport();

  const summary = await syncCollections({ tabId: 7, url: COLLECTIONS_URL, exec, api, report });

  assert.deepEqual(summary, { collections: 1, items: 1, unreadable: [] });
  assert.deepEqual(apiCalls.pushCollectionItems[0].items, [
    {
      external_id: "77",
      title: "Deep Item",
      url: "https://makerworld.com/en/models/77",
      author: null,
      thumbnail_url: null,
    },
  ]);
  // Logs which pageProps key matched, for diagnosability.
  assert.ok(reportCalls.some((c) => c.text.includes("weirdKey")));
});

test("readCollectionsPage: returns null when exec (the page read) throws", async () => {
  const { exec } = stubExec([{ throws: "no such tab" }]);
  const result = await readCollectionsPage({ tabId: 1, exec });
  assert.equal(result, null);
});

test("readCollectionsPage: route pageProps is preferred over a stale inline snapshot", async () => {
  // "Stale" the way the live bug report describes it: __NEXT_DATA__ is from
  // whatever page loaded first, so its favoritesList doesn't match what's
  // actually on the collections page right now.
  const STALE_NEXT_DATA = { buildId: BUILD_ID, props: { pageProps: { favoritesList: [] } } };
  const FRESH_ROUTE_PAGE_PROPS = { favoritesList: NEXT_DATA.props.pageProps.favoritesList };
  const { exec } = stubExec([
    pageResult({ nextData: STALE_NEXT_DATA, routePageProps: FRESH_ROUTE_PAGE_PROPS }),
  ]);
  const result = await readCollectionsPage({ tabId: 1, exec });
  assert.deepEqual(result, { nextData: STALE_NEXT_DATA, entries: ENTRIES, found: true });
});

test("readCollectionsPage: a route-supplied EMPTY favoritesList array is trusted over a non-empty stale inline one", async () => {
  const { exec } = stubExec([
    pageResult({ nextData: NEXT_DATA, routePageProps: { favoritesList: [] } }),
  ]);
  const result = await readCollectionsPage({ tabId: 1, exec });
  assert.deepEqual(result, { nextData: NEXT_DATA, entries: [], found: true });
});

test("readCollectionsPage: route unreachable (routePageProps null) falls back to the inline snapshot", async () => {
  const { exec } = stubExec([pageResult({ nextData: NEXT_DATA, routePageProps: null })]);
  const result = await readCollectionsPage({ tabId: 1, exec });
  assert.deepEqual(result, { nextData: NEXT_DATA, entries: ENTRIES, found: true });
});

test("readCollectionsPage: route missing the favoritesList shape also falls back to the inline snapshot", async () => {
  const { exec } = stubExec([
    pageResult({ nextData: NEXT_DATA, routePageProps: { someOtherField: 1 } }),
  ]);
  const result = await readCollectionsPage({ tabId: 1, exec });
  assert.deepEqual(result, { nextData: NEXT_DATA, entries: ENTRIES, found: true });
});

test("readCollectionsPage: both route and inline missing a favoritesList array returns found:false, entries: []", async () => {
  const { exec } = stubExec([pageResult({ nextData: null, routePageProps: null })]);
  const result = await readCollectionsPage({ tabId: 1, exec });
  assert.deepEqual(result, { nextData: null, entries: [], found: false });
});

test("readCollectionsPage: extracts entries from a real favoritesList shape via the inline snapshot", async () => {
  const { exec } = stubExec([pageResult({ nextData: NEXT_DATA })]);
  const result = await readCollectionsPage({ tabId: 1, exec });
  assert.deepEqual(result.entries, ENTRIES);
  assert.equal(result.found, true);
});

test("hashCollectionsPayload: stable for the same entries, differs for different entries", async () => {
  const a1 = await hashCollectionsPayload(ENTRIES);
  const a2 = await hashCollectionsPayload(ENTRIES);
  const b = await hashCollectionsPayload([ENTRIES[0]]);
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.match(a1, /^[0-9a-f]{64}$/);
});

test("hashCollectionsPayload: matches hashing the JSON-stringified entries directly (reuses courier's hashToken)", async () => {
  const expected = await hashToken(JSON.stringify(ENTRIES));
  assert.equal(await hashCollectionsPayload(ENTRIES), expected);
});

test("hashCollectionsPayload: null/undefined entries hash the same as an empty array", async () => {
  const empty = await hashCollectionsPayload([]);
  assert.equal(await hashCollectionsPayload(null), empty);
  assert.equal(await hashCollectionsPayload(undefined), empty);
});

test("shouldPushCollections: true when lastHash is null (first sync)", async () => {
  assert.equal(await shouldPushCollections(ENTRIES, null), true);
});

test("shouldPushCollections: false when entries' hash matches lastHash", async () => {
  const hash = await hashCollectionsPayload(ENTRIES);
  assert.equal(await shouldPushCollections(ENTRIES, hash), false);
});

test("shouldPushCollections: true when a collection's count changed (membership edit) even with the same list_id set", async () => {
  const before = [{ list_id: "1", title: "A", slug: null, count: 3, is_default: false }];
  const after = [{ list_id: "1", title: "A", slug: null, count: 4, is_default: false }];
  const beforeHash = await hashCollectionsPayload(before);
  assert.equal(await shouldPushCollections(after, beforeHash), true);
});

test("shouldPersistHash: false when the run left one or more collections unreadable", () => {
  assert.equal(
    shouldPersistHash({ collections: 2, items: 1, unreadable: ["Default Collection"] }),
    false,
  );
});

test("shouldPersistHash: true on a fully-clean run (nothing unreadable)", () => {
  assert.equal(shouldPersistHash({ collections: 2, items: 2, unreadable: [] }), true);
});
