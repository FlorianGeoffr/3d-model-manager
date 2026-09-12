/**
 * Row-chunking helpers for the library gallery's virtualized grid (R9-A item
 * 2). Split out from LibraryPage so the column-count math and row-slicing
 * are unit-testable independent of `@tanstack/react-virtual` and jsdom's
 * lack of real layout.
 */

// Mirrors the grid's own Tailwind breakpoint classes
// (`grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6`)
// -- kept in one place so the virtualizer's row math always matches what's
// actually painted. Checked widest-first.
const GRID_BREAKPOINTS: ReadonlyArray<readonly [minWidth: number, columns: number]> = [
  [1536, 6], // 2xl
  [1280, 5], // xl
  [1024, 4], // lg
  [640, 3], // sm
];
const DEFAULT_COLUMNS = 2;

/** Column count for a grid container of the given pixel width. */
export function columnsForWidth(width: number): number {
  for (const [minWidth, columns] of GRID_BREAKPOINTS) {
    if (width >= minWidth) return columns;
  }
  return DEFAULT_COLUMNS;
}

/** Splits a flat item list into fixed-size rows of `columns` items each (the
 * last row may be shorter). `columns <= 0` degenerates to one item per row
 * rather than looping forever or dropping items. */
export function chunkIntoRows<T>(items: readonly T[], columns: number): T[][] {
  if (columns <= 0) return items.map((item) => [item]);
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += columns) {
    rows.push(items.slice(i, i + columns));
  }
  return rows;
}
