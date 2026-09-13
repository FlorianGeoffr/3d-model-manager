import { describe, expect, it } from "vitest";

import { applyToParts, QUICK_COLORS } from "@/components/viewer/quickColors";

describe("QUICK_COLORS", () => {
  it("has exactly 7 distinct hex swatches", () => {
    expect(QUICK_COLORS).toHaveLength(7);
    expect(new Set(QUICK_COLORS).size).toBe(7);
    for (const hex of QUICK_COLORS) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("applyToParts", () => {
  it("sets the given ids to hex, leaving other entries untouched", () => {
    const colors = { 1: "#111111", 2: "#222222" };
    const next = applyToParts(colors, [2, 3], "#00ccee");
    expect(next).toEqual({ 1: "#111111", 2: "#00ccee", 3: "#00ccee" });
  });

  it("does not mutate the input map", () => {
    const colors = { 1: "#111111" };
    applyToParts(colors, [1], "#ffffff");
    expect(colors).toEqual({ 1: "#111111" });
  });

  it("returns the same reference when ids is empty", () => {
    const colors = { 1: "#111111" };
    expect(applyToParts(colors, [], "#ffffff")).toBe(colors);
  });
});
