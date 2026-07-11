/**
 * The pop-out viewer window's URL contract. Kept in its own module (no React
 * component export) so `parseViewerWindowSearch` can serve as the route's
 * `validateSearch` AND be imported by the page, without tripping the
 * `react(only-export-components)` fast-refresh lint rule.
 */
export interface WindowSearch {
  ids?: string;
  bg?: string;
  bgc?: string;
  light?: string;
  colors?: string;
}

/** Validate + normalize the window's search params. TanStack's default parser
 * runs `JSON.parse` on each value, so a single numeric id (`?ids=13`) arrives
 * as the NUMBER 13, not "13" -- coerce primitives back to string so both
 * single-part and multi-part (`?ids=13,19`, already a non-numeric string)
 * links survive. Anything that isn't a string or number (objects, arrays,
 * null) drops to undefined. Everything downstream treats these as strings. */
export function parseViewerWindowSearch(search: Record<string, unknown>): WindowSearch {
  const asString = (value: unknown): string | undefined =>
    typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
  return {
    ids: asString(search.ids),
    bg: asString(search.bg),
    bgc: asString(search.bgc),
    light: asString(search.light),
    colors: asString(search.colors),
  };
}
