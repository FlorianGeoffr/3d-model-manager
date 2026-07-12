import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hashCollectionsPayload,
  readCollectionsPage,
  shouldPushCollections,
  syncCollections,
} from "../src/syncFlow.js";
import { hashToken } from "../src/courier.js";

// Mirrors backend/tests/cassettes/makerworld_fixtures.py FAVORITES_LIST /
// test/collections.test.js's fixtures -- two visible collections.
const NEXT_DATA = {
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

const COLLECTIONS_URL = "https://makerworld.com/en/@Terminalfoo/collections";

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

test("syncCollections: happy path -- pushes the list, fetches+pushes each collection's items, returns the summary", async () => {
  const { exec } = stubExec([
    { result: NEXT_DATA },
    { result: [{ hits: [{ id: 1, title: "Item A" }], total: 1 }] },
    { result: [{ hits: [{ id: 2, title: "Item B" }], total: 1 }] },
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
  const last = reportCalls[reportCalls.length - 1];
  assert.equal(last.text, "Synced 2 collections (2 items).");
  assert.equal(last.kind, "ok");
});

test("syncCollections: empty favoritesList reports the empty message and pushes nothing", async () => {
  const { exec } = stubExec([{ result: { props: { pageProps: { favoritesList: [] } } } }]);
  const { api, calls: apiCalls } = stubApi();
  const { report, calls: reportCalls } = stubReport();

  await assert.rejects(
    syncCollections({ tabId: 7, url: COLLECTIONS_URL, exec, api, report }),
    /No collections found on this page\./,
  );

  assert.equal(apiCalls.pushCollections.length, 0);
  assert.equal(apiCalls.pushCollectionItems.length, 0);
  assert.deepEqual(reportCalls[reportCalls.length - 1], {
    text: "No collections found on this page.",
    kind: "error",
  });
});

test("syncCollections: an unreadable collection's items are skipped and listed, other collections still sync", async () => {
  const { exec } = stubExec([
    { result: NEXT_DATA },
    { throws: "injection failed" }, // first collection's item fetch fails
    { result: [{ hits: [{ id: 2, title: "Item B" }], total: 1 }] },
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
  const last = reportCalls[reportCalls.length - 1];
  assert.equal(last.text, "Synced 2 collections (1 items). (no items readable: Default Collection)");
  assert.equal(last.kind, "ok");
});

test("syncCollections: a collection whose item push is rejected is also listed as unreadable", async () => {
  const { exec } = stubExec([
    { result: NEXT_DATA },
    { result: [{ hits: [{ id: 1, title: "Item A" }], total: 1 }] },
    { result: [{ hits: [{ id: 2, title: "Item B" }], total: 1 }] },
  ]);
  const { api, calls: apiCalls } = stubApi({
    pushCollectionItems: [errResult("collection not found"), undefined],
  });
  const { report } = stubReport();

  const summary = await syncCollections({ tabId: 7, url: COLLECTIONS_URL, exec, api, report });

  assert.deepEqual(summary, { collections: 2, items: 1, unreadable: ["Default Collection"] });
  assert.equal(apiCalls.pushCollectionItems.length, 2);
});

test("syncCollections: a missing handle pushes the list, skips items, and reports a distinct message", async () => {
  // A URL that doesn't match /@handle/collections and NEXT_DATA with no
  // recognizable handle field -- extractHandle returns null.
  const { exec } = stubExec([{ result: NEXT_DATA }]);
  const { api, calls: apiCalls } = stubApi();
  const { report, calls: reportCalls } = stubReport();

  const summary = await syncCollections({
    tabId: 7,
    url: "https://makerworld.com/some/other/page",
    exec,
    api,
    report,
  });

  assert.deepEqual(summary, { collections: 2, items: 0, unreadable: [] });
  assert.equal(apiCalls.pushCollections.length, 1);
  assert.equal(apiCalls.pushCollectionItems.length, 0);
  assert.deepEqual(reportCalls[reportCalls.length - 1], {
    text: "Synced 2 collections. Couldn't read a handle to fetch their items.",
    kind: "ok",
  });
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
  const { exec, calls: execCalls } = stubExec([{ result: NEXT_DATA }]);
  const { api } = stubApi({ pushCollections: errResult("collections: at most 200 entries") });
  const { report, calls: reportCalls } = stubReport();

  await assert.rejects(
    syncCollections({ tabId: 7, url: COLLECTIONS_URL, exec, api, report }),
    /collections: at most 200 entries/,
  );

  assert.equal(execCalls.length, 1); // only the __NEXT_DATA__ read -- no item fetches
  assert.deepEqual(reportCalls[reportCalls.length - 1], {
    text: "collections: at most 200 entries",
    kind: "error",
  });
});

test("syncCollections: a rejected list push with no error text falls back to a generic message", async () => {
  const { exec } = stubExec([{ result: NEXT_DATA }]);
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
    { result: [{ hits: [{ id: 1, title: "Item A" }], total: 1 }] },
    { result: [{ hits: [{ id: 2, title: "Item B" }], total: 1 }] },
  ]);
  const { api, calls: apiCalls } = stubApi();
  const { report } = stubReport();

  const summary = await syncCollections({
    tabId: 7,
    url: COLLECTIONS_URL,
    exec,
    api,
    report,
    page: { nextData: NEXT_DATA, entries: ENTRIES },
  });

  assert.deepEqual(summary, { collections: 2, items: 2, unreadable: [] });
  // Only the two item-fetch exec calls -- no exec call for __NEXT_DATA__.
  assert.equal(execCalls.length, 2);
  assert.deepEqual(apiCalls.pushCollections[0].collections, ENTRIES);
});

test("readCollectionsPage: returns null when exec (the page read) throws", async () => {
  const { exec } = stubExec([{ throws: "no such tab" }]);
  const result = await readCollectionsPage({ tabId: 1, exec });
  assert.equal(result, null);
});

test("readCollectionsPage: returns {nextData, entries} on a successful read, entries empty when favoritesList is empty", async () => {
  const { exec } = stubExec([{ result: { props: { pageProps: { favoritesList: [] } } } }]);
  const result = await readCollectionsPage({ tabId: 1, exec });
  assert.deepEqual(result, {
    nextData: { props: { pageProps: { favoritesList: [] } } },
    entries: [],
  });
});

test("readCollectionsPage: extracts entries from a real favoritesList shape", async () => {
  const { exec } = stubExec([{ result: NEXT_DATA }]);
  const result = await readCollectionsPage({ tabId: 1, exec });
  assert.deepEqual(result.entries, ENTRIES);
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
