import { describe, expect, it } from "vitest";

import { humanizeDuration } from "@/lib/format";

describe("humanizeDuration", () => {
  it("shows hours and minutes for durations over an hour", () => {
    expect(humanizeDuration(5400)).toBe("1h 30m");
  });

  it("shows minutes only for durations under an hour", () => {
    expect(humanizeDuration(2700)).toBe("45m");
  });

  it("shows '<1m' for durations under a minute", () => {
    expect(humanizeDuration(30)).toBe("<1m");
    expect(humanizeDuration(0)).toBe("<1m");
  });

  it("shows '<1m' for non-finite input instead of throwing", () => {
    expect(humanizeDuration(Number.NaN)).toBe("<1m");
  });
});
