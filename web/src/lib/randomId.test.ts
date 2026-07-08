import { afterEach, describe, expect, it, vi } from "vitest";

import { randomId } from "./randomId";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a v4 UUID when crypto.randomUUID is available (secure context)", () => {
    expect(randomId()).toMatch(UUID_V4);
  });

  it("returns distinct ids across calls", () => {
    expect(randomId()).not.toBe(randomId());
  });

  it("falls back to getRandomValues when randomUUID is undefined (non-secure context)", () => {
    // Simulate an insecure origin (plain HTTP over a LAN IP/hostname): the
    // Crypto interface exists and getRandomValues works, but randomUUID and
    // subtle are gated out and thus undefined.
    const getRandomValues = <T extends ArrayBufferView | null>(arr: T): T => {
      if (arr) {
        const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff;
      }
      return arr;
    };
    vi.stubGlobal("crypto", { getRandomValues });

    const id = randomId();
    expect(id).toMatch(UUID_V4);
    expect(randomId()).toMatch(UUID_V4);
  });
});
