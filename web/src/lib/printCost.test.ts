import { describe, expect, it } from "vitest";

import { estimatePrintCost, formatPrintCost } from "@/lib/printCost";

const SETTINGS = { filament_cost_per_kg: 20, machine_cost_per_hour: 2 };

describe("estimatePrintCost", () => {
  it("computes filament + machine cost from grams and seconds", () => {
    // 100g @ 20/kg = 2.0; 3600s (1h) @ 2/hr = 2.0
    const cost = estimatePrintCost({ filament_g: 100, duration_s: 3600 }, SETTINGS);
    expect(cost).toBeCloseTo(4.0);
  });

  it("computes filament-only cost when duration is missing", () => {
    const cost = estimatePrintCost({ filament_g: 250, duration_s: null }, SETTINGS);
    expect(cost).toBeCloseTo(5.0);
  });

  it("computes machine-only cost when filament is missing", () => {
    const cost = estimatePrintCost({ filament_g: undefined, duration_s: 1800 }, SETTINGS);
    expect(cost).toBeCloseTo(1.0);
  });

  it("returns null when both fields are missing", () => {
    expect(estimatePrintCost({ filament_g: null, duration_s: undefined }, SETTINGS)).toBeNull();
  });

  it("returns 0 when both rates are 0", () => {
    const cost = estimatePrintCost(
      { filament_g: 500, duration_s: 7200 },
      { filament_cost_per_kg: 0, machine_cost_per_hour: 0 },
    );
    expect(cost).toBe(0);
  });
});

describe("formatPrintCost", () => {
  it("formats with 2 decimals and no currency symbol", () => {
    expect(formatPrintCost(4)).toBe("4.00");
    expect(formatPrintCost(1.005)).toBe("1.00"); // toFixed's own rounding, no surprise here
    expect(formatPrintCost(2.5)).toBe("2.50");
  });
});
