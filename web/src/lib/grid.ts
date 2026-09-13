/**
 * Row-chunking helpers for the library gallery's virtualized grid (R9-A item
 * 2). Split out from LibraryPage so the column-count math and row-slicing
 * are unit-testable independent of `@tanstack/react-virtual` and jsdom's
 * lack of real layout.
 */

// Fix wave finding 2: these breakpoints are evaluated against the grid
// CONTAINER's measured width (the `LibraryPage` grid `<div>`'s own
// `ResizeObserver`), not the viewport -- the container is narrower than the
// viewport by the sidebar + page padding, so reusing Tailwind's viewport
// breakpoint numbers here is deliberate (the numbers are the same; only the
// measurement basis differs) rather than a coincidence to "fix" back to
// viewport-based classes. `LibraryPage` renders `columns` as an inline
// `gridTemplateColumns` from this same function's result, so the chunking
// here and the painted columns can never disagree. Checked widest-first.
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

// Row-height estimate for the virtualized grid (R9-A item 2, fix round 1):
// `ModelCard` renders an aspect-square image, so a row's height scales
// directly with column width -- a fixed estimate overlaps/gaps badly as
// column count changes across breakpoints. These constants mirror
// ModelCard's/Card's/CardContent's actual Tailwind classes so the estimate
// tracks the real layout instead of a guessed number.
export const GRID_GAP_PX = 16; // grid's `gap-4` -- column gap, and the vertical gap this module gives each virtual row
const CARD_INTERNAL_GAP_PX = 12; // ModelCard's <Card className="... gap-3 ...">, between the image and CardContent
const CARD_PADDING_BOTTOM_PX = 16; // Card's own `pb-4`
const CARD_CONTENT_GAP_PX = 8; // CardContent's `gap-2` between each of its rows
// CardContent's rows, in order: name (h3), spec row, tags row, format
// badges, updated date -- approximate single-line heights.
const CARD_CONTENT_ROWS_HEIGHT_PX = 20 + 20 + 20 + 24 + 16;
const CARD_CONTENT_ROW_COUNT = 5;
/** Everything below a card's square image: the gap to CardContent, its own
 * internal rows and their gaps, and the card's bottom padding. */
export const CARD_FOOTER_HEIGHT_PX =
  CARD_INTERNAL_GAP_PX +
  CARD_CONTENT_ROWS_HEIGHT_PX +
  CARD_CONTENT_GAP_PX * (CARD_CONTENT_ROW_COUNT - 1) +
  CARD_PADDING_BOTTOM_PX;

/** Estimates a virtualized row's height from the grid container's own
 * measured width: card width is derived by dividing the container width
 * (minus the inter-column gaps) by the column count, then a card's
 * (aspect-square) height equals its width, plus the fixed footer height and
 * the vertical gap between rows. Falls back to a reasonable guess before
 * the container has been measured (width/columns <= 0, e.g. jsdom's first
 * render, where every element reports 0). */
export function estimateRowHeight(containerWidth: number, columns: number): number {
  if (containerWidth <= 0 || columns <= 0) {
    // Unmeasured fallback: assume a mid-size single card width (~300px).
    return 300 + CARD_FOOTER_HEIGHT_PX + GRID_GAP_PX;
  }
  const cardWidth = (containerWidth - GRID_GAP_PX * (columns - 1)) / columns;
  return cardWidth + CARD_FOOTER_HEIGHT_PX + GRID_GAP_PX;
}

// R13b list view: `ModelRow` is a fixed-height horizontal row (96px thumb +
// padding), unlike the grid's aspect-square cards -- so, unlike
// `estimateRowHeight` above, this needs no container-width math at all. One
// constant, shared by the virtualizer's `estimateSize` and `ModelRow` itself
// so the two can never disagree.
export const LIST_ROW_HEIGHT_PX = 96 + GRID_GAP_PX;

/** List view always has exactly one item per virtual row (unlike the grid's
 * `chunkIntoRows`, which fans out across `columns`) -- this just documents
 * that intent at the call site while giving list rows their own fixed
 * estimate function, mirroring `estimateRowHeight`'s signature-less-columns
 * shape for parity. */
export function estimateListRowHeight(): number {
  return LIST_ROW_HEIGHT_PX;
}
