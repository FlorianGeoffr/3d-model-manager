import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FilamentChip, normalizeHex } from "@/components/ui/filament-chip";

describe("normalizeHex", () => {
  it("passes through a #RRGGBB color", () => {
    expect(normalizeHex("#ff0000")).toBe("#ff0000");
  });

  it("adds a missing leading #", () => {
    expect(normalizeHex("00ff00")).toBe("#00ff00");
  });

  it("strips the trailing alpha of an 8-hex color", () => {
    expect(normalizeHex("AABBCCDD")).toBe("#AABBCC");
    expect(normalizeHex("#AABBCCDD")).toBe("#AABBCC");
  });

  it("returns null for empty or unparseable input", () => {
    expect(normalizeHex("")).toBeNull();
    expect(normalizeHex(undefined)).toBeNull();
    expect(normalizeHex(null)).toBeNull();
    expect(normalizeHex("xyz")).toBeNull();
    expect(normalizeHex("#12")).toBeNull();
  });
});

describe("FilamentChip", () => {
  it("renders a swatch with the given color as its background", () => {
    render(<FilamentChip color="#ff0000" label="Red" material="PLA" />);
    const swatch = screen.getByTitle(/PLA/);
    expect(swatch.style.backgroundColor).toBe("rgb(255, 0, 0)");
  });

  it("renders a placeholder (no inline background) for a missing/garbage color", () => {
    const { container } = render(<FilamentChip color="not-a-color" label="Unknown" />);
    expect(container.querySelector('[style*="background"]')).toBeNull();
  });

  it("exposes an accessible description even when color-only", () => {
    render(<FilamentChip color="#123456" material="PETG" />);
    expect(screen.getByTitle(/PETG/)).toBeInTheDocument();
    // the sr-only description carries the resolved hex
    expect(screen.getByText(/#123456/)).toBeInTheDocument();
  });
});
