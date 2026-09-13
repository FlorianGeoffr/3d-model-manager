import { describe, expect, it } from "vitest";

import { isSameSelection, type StudioSelection } from "@/components/model-detail/studioSelection";

describe("isSameSelection", () => {
  it("matches assembly to assembly and file ids to themselves", () => {
    expect(isSameSelection({ type: "assembly" }, { type: "assembly" })).toBe(true);
    expect(isSameSelection({ type: "file", id: 1 }, { type: "file", id: 1 })).toBe(true);
    expect(isSameSelection({ type: "file", id: 1 }, { type: "file", id: 2 })).toBe(false);
    expect(isSameSelection({ type: "assembly" }, { type: "file", id: 1 })).toBe(false);
    expect(isSameSelection(undefined, { type: "assembly" } satisfies StudioSelection)).toBe(false);
  });
});
