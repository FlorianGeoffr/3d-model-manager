import { describe, expect, it } from "vitest";

import { parseViewerWindowSearch } from "@/pages/viewerWindowSearch";

describe("parseViewerWindowSearch", () => {
  // The regression this exists to guard: TanStack's default search parser
  // JSON.parses each value, turning `?ids=13` into the number 13. A naive
  // `typeof === "string"` validator would drop it, and the window would show
  // every part instead of the one that was popped out.
  it("coerces a single numeric id back to a string", () => {
    expect(parseViewerWindowSearch({ ids: 13 })).toMatchObject({ ids: "13" });
  });

  it("keeps a comma-joined multi-part id string as-is", () => {
    expect(parseViewerWindowSearch({ ids: "13,19" })).toMatchObject({ ids: "13,19" });
  });

  it("passes the preset/color params through untouched", () => {
    expect(
      parseViewerWindowSearch({ bg: "custom", bgc: "#123456", light: "flat", colors: "13:ff0000" }),
    ).toMatchObject({ ids: undefined, bg: "custom", bgc: "#123456", light: "flat", colors: "13:ff0000" });
  });

  it("drops non-primitive or missing values to undefined", () => {
    expect(parseViewerWindowSearch({ ids: { nope: 1 }, bg: null })).toEqual({
      ids: undefined,
      bg: undefined,
      bgc: undefined,
      light: undefined,
      colors: undefined,
      grid: undefined,
      wf: undefined,
      xr: undefined,
      rot: undefined,
      cam: undefined,
      sec: undefined,
      ex: undefined,
    });
  });

  // Task 6 view-tools params: `grid=0`/`grid=1`, `wf=1`, `rot=1`, and
  // `ex=0.40` are all valid JSON, so TanStack's default parser hands them to
  // `parseViewerWindowSearch` as NUMBERS (0.4, not "0.40") -- same regression
  // class as the numeric `ids` case above.
  it("coerces the grid/wf/xr/rot/ex numeric-looking params back to strings", () => {
    expect(parseViewerWindowSearch({ grid: 0, wf: 1, xr: 1, rot: 1, ex: 0.4 })).toMatchObject({
      grid: "0",
      wf: "1",
      xr: "1",
      rot: "1",
      ex: "0.4",
    });
  });

  // `cam=o` and `sec=x:0.35` aren't valid JSON, so they arrive as plain
  // strings already -- passed through untouched, same as `bg`/`light`.
  it("passes cam/sec through untouched", () => {
    expect(parseViewerWindowSearch({ cam: "o", sec: "x:0.35" })).toMatchObject({
      cam: "o",
      sec: "x:0.35",
    });
  });
});
