import { describe, expect, it } from "vitest";

import { statusRefetchInterval } from "@/api/printers";

describe("statusRefetchInterval (usePrinterStatus poll cadence, Task 11)", () => {
  it("polls fast (a positive interval) while the printer is actively printing", () => {
    for (const state of ["RUNNING", "PREPARE", "PAUSE"]) {
      const interval = statusRefetchInterval(state);
      expect(typeof interval).toBe("number");
      expect(interval).toBeGreaterThan(0);
    }
  });

  it("stops polling (false) once gcode_state is confirmed-terminal", () => {
    for (const state of ["FINISH", "FAILED", "IDLE"]) {
      expect(statusRefetchInterval(state)).toBe(false);
    }
  });

  it("keeps a slow heartbeat for an unknown/empty/transient state rather than stopping", () => {
    expect(statusRefetchInterval("UNKNOWN")).toBe(8000);
    expect(statusRefetchInterval("")).toBe(8000);
    expect(statusRefetchInterval(undefined)).toBe(8000);
  });
});
