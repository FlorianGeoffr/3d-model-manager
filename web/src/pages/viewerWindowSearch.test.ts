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
    ).toEqual({ ids: undefined, bg: "custom", bgc: "#123456", light: "flat", colors: "13:ff0000" });
  });

  it("drops non-primitive or missing values to undefined", () => {
    expect(parseViewerWindowSearch({ ids: { nope: 1 }, bg: null })).toEqual({
      ids: undefined,
      bg: undefined,
      bgc: undefined,
      light: undefined,
      colors: undefined,
    });
  });
});
