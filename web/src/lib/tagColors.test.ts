import { describe, expect, it } from "vitest";

import { TAG_COLORS, tagColorClass, tagSwatchClass } from "@/lib/tagColors";

describe("tagColorClass", () => {
  it("returns a Tailwind class string for a known color", () => {
    expect(tagColorClass("teal")).toMatch(/bg-teal-100/);
  });

  it("returns undefined for no color", () => {
    expect(tagColorClass(null)).toBeUndefined();
    expect(tagColorClass(undefined)).toBeUndefined();
  });
});

describe("tagSwatchClass", () => {
  it("returns a distinct class for every palette key", () => {
    const classes = new Set(TAG_COLORS.map(tagSwatchClass));
    expect(classes.size).toBe(TAG_COLORS.length);
  });
});
