import { describe, expect, it } from "vitest";

import { resolveBackground } from "@/components/viewer/background";

describe("resolveBackground", () => {
  it("resolves the studio preset regardless of theme or custom color", () => {
    expect(resolveBackground("studio", "#123456", false)).toBe("#a1a1aa");
    expect(resolveBackground("studio", "#123456", true)).toBe("#a1a1aa");
  });

  it("resolves the white preset", () => {
    expect(resolveBackground("white", "#123456", false)).toBe("#ffffff");
  });

  it("resolves the dark preset", () => {
    expect(resolveBackground("dark", "#123456", false)).toBe("#18181b");
  });

  it("resolves the custom preset to the given hex", () => {
    expect(resolveBackground("custom", "#654321", false)).toBe("#654321");
  });

  it("falls back to the studio hex when the custom preset has no color", () => {
    expect(resolveBackground("custom", "", false)).toBe("#a1a1aa");
  });

  it("follows the app theme: dark resolves to the dark neutral", () => {
    expect(resolveBackground("theme", "#000000", true)).toBe("#18181b");
  });

  it("follows the app theme: light resolves to a light neutral", () => {
    expect(resolveBackground("theme", "#000000", false)).toBe("#e5e5e5");
  });
});
