import { test } from "node:test";
import assert from "node:assert/strict";

import { createClient } from "../src/api.js";

/** Installs a stub `fetch` for the duration of `fn`, then restores it. */
async function withStubFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `Status ${status}`,
    json: async () => body,
  };
}

test("ping: hits GET <base>/api/ext/ping with the bearer header, no body", async () => {
  await withStubFetch(
    () => jsonResponse(200, { ok: true }),
    async (calls) => {
      const client = createClient({ baseUrl: "http://nas.local:8080/", token: "tok123" });
      const result = await client.ping();

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "http://nas.local:8080/api/ext/ping");
      assert.equal(calls[0].init.method, "GET");
      assert.equal(calls[0].init.headers.Authorization, "Bearer tok123");
      assert.equal(calls[0].init.body, undefined);
      assert.deepEqual(result, { ok: true, status: 200, data: { ok: true }, error: null });
    }
  );
});

test("baseUrl: a trailing slash is trimmed before building the request URL", async () => {
  await withStubFetch(
    () => jsonResponse(200, { ok: true }),
    async (calls) => {
      const client = createClient({ baseUrl: "http://nas.local:8080///", token: "t" });
      await client.ping();
      assert.equal(calls[0].url, "http://nas.local:8080/api/ext/ping");
    }
  );
});

test("createImport: POSTs the url as JSON with Content-Type", async () => {
  await withStubFetch(
    () => jsonResponse(201, { id: "abc", state: "queued", site: "makerworld" }),
    async (calls) => {
      const client = createClient({ baseUrl: "http://nas.local:8080", token: "tok123" });
      const result = await client.createImport("https://makerworld.com/en/models/1-foo");

      assert.equal(calls[0].url, "http://nas.local:8080/api/ext/imports");
      assert.equal(calls[0].init.method, "POST");
      assert.equal(calls[0].init.headers["Content-Type"], "application/json");
      assert.deepEqual(JSON.parse(calls[0].init.body), {
        url: "https://makerworld.com/en/models/1-foo",
      });
      assert.equal(result.ok, true);
      assert.equal(result.status, 201);
    }
  );
});

test("setMakerworldCredential: POSTs the cookie value as {token}", async () => {
  await withStubFetch(
    () => jsonResponse(200, { ok: true }),
    async (calls) => {
      const client = createClient({ baseUrl: "http://nas.local:8080", token: "tok123" });
      await client.setMakerworldCredential("cookie-value");

      assert.equal(calls[0].url, "http://nas.local:8080/api/ext/credentials/makerworld");
      assert.deepEqual(JSON.parse(calls[0].init.body), { token: "cookie-value" });
    }
  );
});

test("non-2xx: surfaces the response's `detail` as `error`", async () => {
  await withStubFetch(
    () => jsonResponse(422, { detail: "Unsupported or invalid URL" }),
    async () => {
      const client = createClient({ baseUrl: "http://nas.local:8080", token: "tok123" });
      const result = await client.createImport("https://example.com/not-a-model");

      assert.equal(result.ok, false);
      assert.equal(result.status, 422);
      assert.equal(result.error, "Unsupported or invalid URL");
    }
  );
});

test("non-2xx: joins an array `detail` (FastAPI validation shape) instead of stringifying it", async () => {
  await withStubFetch(
    () =>
      jsonResponse(422, {
        detail: [
          { loc: ["body", "url"], msg: "field required", type: "value_error.missing" },
          { loc: ["body", "token"], msg: "field required", type: "value_error.missing" },
        ],
      }),
    async () => {
      const client = createClient({ baseUrl: "http://nas.local:8080", token: "tok123" });
      const result = await client.createImport("https://example.com/not-a-model");

      assert.equal(result.ok, false);
      assert.equal(result.status, 422);
      assert.equal(result.error, "field required; field required");
      assert.doesNotMatch(result.error, /\[object Object\]/);
    }
  );
});

test("401: surfaces as a non-ok result without throwing", async () => {
  await withStubFetch(
    () => jsonResponse(401, { detail: "Not authenticated" }),
    async () => {
      const client = createClient({ baseUrl: "http://nas.local:8080", token: "bad" });
      const result = await client.ping();

      assert.equal(result.ok, false);
      assert.equal(result.status, 401);
      assert.equal(result.error, "Not authenticated");
    }
  );
});

test("network failure: resolves to a normalized error instead of throwing", async () => {
  await withStubFetch(
    () => {
      throw new Error("getaddrinfo ENOTFOUND nas.local");
    },
    async () => {
      const client = createClient({ baseUrl: "http://nas.local:8080", token: "tok123" });
      const result = await client.ping();

      assert.equal(result.ok, false);
      assert.equal(result.status, 0);
      assert.match(result.error, /ENOTFOUND/);
    }
  );
});
