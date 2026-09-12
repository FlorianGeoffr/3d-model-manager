import { describe, expect, it } from "vitest";

import { chunkIntoRows, columnsForWidth, estimateRowHeight } from "@/lib/grid";

describe("columnsForWidth", () => {
  it("matches the grid's own Tailwind breakpoints (sm/lg/xl/2xl)", () => {
    expect(columnsForWidth(0)).toBe(2);
    expect(columnsForWidth(639)).toBe(2);
    expect(columnsForWidth(640)).toBe(3);
    expect(columnsForWidth(1023)).toBe(3);
    expect(columnsForWidth(1024)).toBe(4);
    expect(columnsForWidth(1279)).toBe(4);
    expect(columnsForWidth(1280)).toBe(5);
    expect(columnsForWidth(1535)).toBe(5);
    expect(columnsForWidth(1536)).toBe(6);
    expect(columnsForWidth(2000)).toBe(6);
  });
});

describe("chunkIntoRows", () => {
  it("splits items into fixed-size rows, with a shorter last row", () => {
    expect(chunkIntoRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns one row when columns >= item count", () => {
    expect(chunkIntoRows([1, 2], 4)).toEqual([[1, 2]]);
  });

  it("returns no rows for an empty item list", () => {
    expect(chunkIntoRows([], 3)).toEqual([]);
  });

  it("degenerates to one item per row for a non-positive column count", () => {
    expect(chunkIntoRows([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
    expect(chunkIntoRows([1, 2], -1)).toEqual([[1], [2]]);
  });
});

describe("estimateRowHeight", () => {
  it("scales with the measured container width, not a fixed guess (fix round 1)", () => {
    // Same column count (2, the smallest breakpoint), two different
    // container widths -- a fixed estimate would return the same number for
    // both, which is exactly the bug this fixes: cards are aspect-square,
    // so a wider container means visibly taller rows.
    const narrow = estimateRowHeight(400, 2);
    const wide = estimateRowHeight(800, 2);

    expect(narrow).not.toBe(wide);
    expect(wide).toBeGreaterThan(narrow);
  });

  it("is always taller than a single card's own width (footer + gap add height beyond the square image)", () => {
    const columns = 3;
    const containerWidth = 900;
    const cardWidth = (containerWidth - 16 * (columns - 1)) / columns;

    expect(estimateRowHeight(containerWidth, columns)).toBeGreaterThan(cardWidth);
  });

  it("falls back to a fixed guess when unmeasured (width or columns <= 0)", () => {
    expect(estimateRowHeight(0, 2)).toBe(estimateRowHeight(0, 3));
    expect(estimateRowHeight(400, 0)).toBe(estimateRowHeight(0, 0));
  });
});
