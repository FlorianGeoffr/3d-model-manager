import { describe, expect, it } from "vitest";

import { explodeControlLabel, explodeLayout, type PartExtent } from "@/components/viewer/explode";

/** Two parts spread far apart -- a genuine assembly, not an overlapping
 * pile. Shared by the "explode" branch tests below. */
const ASSEMBLY: PartExtent[] = [
  { id: 0, center: [0, 0, 0], size: [10, 10, 10] },
  { id: 1, center: [100, 0, 0], size: [10, 10, 10] },
];

/** N unit-cube parts all centered on the origin -- the "separate STL files
 * each centered on their own origin" case that should fall back to a grid. */
function overlappingPile(n: number): PartExtent[] {
  return Array.from({ length: n }, (_, id) => ({
    id,
    center: [0, 0, 0] as [number, number, number],
    size: [1, 1, 1] as [number, number, number],
  }));
}

describe("explodeLayout mode classification", () => {
  it("fewer than 2 parts -> none", () => {
    expect(explodeLayout([{ id: 0, center: [0, 0, 0], size: [1, 1, 1] }], 1)).toEqual({
      mode: "none",
      offsets: new Map(),
    });
  });

  it("empty input -> none, empty map", () => {
    expect(explodeLayout([], 1)).toEqual({ mode: "none", offsets: new Map() });
  });

  it("two parts with centers far apart -> explode", () => {
    expect(explodeLayout(ASSEMBLY, 1).mode).toBe("explode");
  });

  it("two+ parts all centered at the origin -> separate", () => {
    expect(explodeLayout(overlappingPile(2), 1).mode).toBe("separate");
    expect(explodeLayout(overlappingPile(5), 1).mode).toBe("separate");
  });

  it("zero-size parts -> none (degenerate geometry)", () => {
    const parts: PartExtent[] = [
      { id: 0, center: [0, 0, 0], size: [0, 0, 0] },
      { id: 1, center: [5, 0, 0], size: [0, 0, 0] },
    ];
    expect(explodeLayout(parts, 1)).toEqual({ mode: "none", offsets: new Map() });
  });
});

describe("explodeLayout radial (explode) branch", () => {
  it("offsets equal (center - allCenter) * explode at explode = 1", () => {
    const { mode, offsets } = explodeLayout(ASSEMBLY, 1);
    expect(mode).toBe("explode");
    // Union box: x spans [-5, 105] -> allCenter.x = 50; y/z both centered on 0.
    expect(offsets.get(0)).toEqual([-50, 0, 0]);
    expect(offsets.get(1)).toEqual([50, 0, 0]);
  });

  it("scales linearly: offset at 0.5 is exactly half the offset at 1", () => {
    const full = explodeLayout(ASSEMBLY, 1).offsets;
    const half = explodeLayout(ASSEMBLY, 0.5).offsets;
    for (const id of [0, 1]) {
      const f = full.get(id)!;
      const h = half.get(id)!;
      expect(h).toEqual([f[0] / 2, f[1] / 2, f[2] / 2]);
    }
  });

  it("explode = 0 -> every offset is [0,0,0]", () => {
    const { offsets } = explodeLayout(ASSEMBLY, 0);
    expect(offsets.get(0)).toEqual([0, 0, 0]);
    expect(offsets.get(1)).toEqual([0, 0, 0]);
  });

  it("returns exactly the input part ids", () => {
    const { offsets } = explodeLayout(ASSEMBLY, 1);
    expect(new Set(offsets.keys())).toEqual(new Set([0, 1]));
  });
});

describe("explodeLayout grid (separate) branch", () => {
  it("4 overlapping unit-cube parts land in a 2x2 grid with no overlap, Y offset 0", () => {
    const { mode, offsets } = explodeLayout(overlappingPile(4), 1);
    expect(mode).toBe("separate");

    // cellW = cellD = 1, gap = 0.2 * 1 = 0.2, step = 1.2.
    expect(offsets.get(0)).toEqual([-0.6, 0, -0.6]);
    expect(offsets.get(1)).toEqual([0.6, 0, -0.6]);
    expect(offsets.get(2)).toEqual([-0.6, 0, 0.6]);
    expect(offsets.get(3)).toEqual([0.6, 0, 0.6]);

    // Resulting centers (input center [0,0,0] + offset) are distinct and
    // pairwise separated by at least the part size (1) along the grid axes.
    const centers = [0, 1, 2, 3].map((id) => offsets.get(id)!);
    for (let i = 0; i < centers.length; i++) {
      for (let j = i + 1; j < centers.length; j++) {
        const dx = Math.abs(centers[i][0] - centers[j][0]);
        const dz = Math.abs(centers[i][2] - centers[j][2]);
        expect(dx >= 1 || dz >= 1).toBe(true);
      }
      expect(centers[i][1]).toBe(0);
    }
  });

  it("offsets are linear in explode: 0.5 is half of 1, and 0 is all-zero", () => {
    const full = explodeLayout(overlappingPile(4), 1).offsets;
    const half = explodeLayout(overlappingPile(4), 0.5).offsets;
    const zero = explodeLayout(overlappingPile(4), 0).offsets;
    for (const id of [0, 1, 2, 3]) {
      const f = full.get(id)!;
      const h = half.get(id)!;
      expect(h).toEqual([f[0] / 2, f[1] / 2, f[2] / 2]);
      expect(zero.get(id)).toEqual([0, 0, 0]);
    }
  });

  it("is deterministic: a shuffled input order produces identical offsets per id", () => {
    const ordered = overlappingPile(4);
    const shuffled = [ordered[2], ordered[0], ordered[3], ordered[1]];

    const a = explodeLayout(ordered, 1).offsets;
    const b = explodeLayout(shuffled, 1).offsets;

    for (const id of [0, 1, 2, 3]) {
      expect(b.get(id)).toEqual(a.get(id));
    }
  });

  it.each([
    [2, 2, 1],
    [3, 2, 2],
    [4, 2, 2],
    [5, 3, 2],
    [6, 3, 2],
    [7, 3, 3],
    [8, 3, 3],
    [9, 3, 3],
  ])("N=%i parts imply a %i-col x %i-row grid", (n, expectedCols, expectedRows) => {
    const { offsets } = explodeLayout(overlappingPile(n), 1);
    // Parts are unit cubes centered on the origin, so offset.x/z *is* the
    // grid cell's target x/z (allCenter is the origin, explode = 1).
    const xs = new Set([...offsets.values()].map((o) => Math.round(o[0] * 1000)));
    const zs = new Set([...offsets.values()].map((o) => Math.round(o[2] * 1000)));
    expect(xs.size).toBe(expectedCols);
    expect(zs.size).toBe(expectedRows);
  });
});

describe("explodeControlLabel", () => {
  it("maps each mode to its sentence-case label", () => {
    expect(explodeControlLabel("explode")).toBe("Explode");
    expect(explodeControlLabel("separate")).toBe("Separate parts");
    expect(explodeControlLabel("none")).toBe("");
  });
});
