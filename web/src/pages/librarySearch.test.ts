import { describe, expect, it } from "vitest";

import { parseLibrarySearch } from "@/pages/librarySearch";

describe("parseLibrarySearch", () => {
  // TanStack's default search parser JSON.parses each value, so `?collection=5`
  // already arrives as the number 5 -- the common case, passed straight through.
  it("passes a numeric collection id through", () => {
    expect(parseLibrarySearch({ collection: 5 })).toEqual({ collection: 5 });
  });

  it("drops a missing collection param to undefined", () => {
    expect(parseLibrarySearch({})).toEqual({ collection: undefined });
  });

  // A hand-edited or stale link (`?collection=abc`, or JSON like `?collection={}`)
  // must not leak through as a bogus filter value.
  it("drops a non-numeric collection value to undefined", () => {
    expect(parseLibrarySearch({ collection: "abc" })).toEqual({ collection: undefined });
    expect(parseLibrarySearch({ collection: { nope: 1 } })).toEqual({ collection: undefined });
    expect(parseLibrarySearch({ collection: null })).toEqual({ collection: undefined });
  });
});
