import { describe, expect, it } from "vitest";

import { chunkIntoRows, columnsForWidth } from "@/lib/grid";

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
