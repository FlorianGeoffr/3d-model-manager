import { test } from "node:test";
import assert from "node:assert/strict";

import { hashToken, shouldPush } from "../src/courier.js";

test("hashToken: stable for the same input, differs for different input", async () => {
  const a1 = await hashToken("secret-cookie-value");
  const a2 = await hashToken("secret-cookie-value");
  const b = await hashToken("different-value");
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.match(a1, /^[0-9a-f]{64}$/);
});

test("shouldPush: false for an empty/missing current value", async () => {
  assert.equal(await shouldPush("", "anyhash"), false);
  assert.equal(await shouldPush(null, "anyhash"), false);
  assert.equal(await shouldPush(undefined, null), false);
});

test("shouldPush: false when the current value's hash matches lastPushedHash", async () => {
  const value = "cookie-value-123";
  const hash = await hashToken(value);
  assert.equal(await shouldPush(value, hash), false);
});

test("shouldPush: true when the current value's hash differs from lastPushedHash", async () => {
  assert.equal(await shouldPush("new-cookie-value", null), true);
  assert.equal(await shouldPush("new-cookie-value", await hashToken("old-cookie-value")), true);
});
