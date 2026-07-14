import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useOpenMap } from "./useOpenMap";

describe("useOpenMap", () => {
  it("defaults every id to open when defaultOpen is true", () => {
    const { result } = renderHook(() => useOpenMap(["a", "b", "c"], true));

    expect(result.current.isOpen("a")).toBe(true);
    expect(result.current.isOpen("b")).toBe(true);
    expect(result.current.allOpen).toBe(true);
    expect(result.current.allClosed).toBe(false);
  });

  it("defaults every id to closed when defaultOpen is false", () => {
    const { result } = renderHook(() => useOpenMap(["a", "b", "c"], false));

    expect(result.current.isOpen("a")).toBe(false);
    expect(result.current.allClosed).toBe(true);
    expect(result.current.allOpen).toBe(false);
  });

  it("resolves each id through a per-id default predicate", () => {
    const { result } = renderHook(() => useOpenMap(["a", "b", "c"], (id) => id !== "b"));

    expect(result.current.isOpen("a")).toBe(true);
    expect(result.current.isOpen("b")).toBe(false);
    expect(result.current.isOpen("c")).toBe(true);
    // mixed defaults -> neither all-open nor all-closed
    expect(result.current.allOpen).toBe(false);
    expect(result.current.allClosed).toBe(false);
  });

  it("toggle flips only the targeted id, leaving others at their default", () => {
    const { result } = renderHook(() => useOpenMap(["a", "b"], true));

    act(() => result.current.toggle("a"));

    expect(result.current.isOpen("a")).toBe(false);
    expect(result.current.isOpen("b")).toBe(true);
  });

  it("toggling twice returns to the original (default) value", () => {
    const { result } = renderHook(() => useOpenMap(["a"], false));

    act(() => result.current.toggle("a"));
    act(() => result.current.toggle("a"));

    expect(result.current.isOpen("a")).toBe(false);
  });

  it("openAll opens every current id and flips allOpen/allClosed", () => {
    const { result } = renderHook(() => useOpenMap(["a", "b"], false));

    expect(result.current.allOpen).toBe(false);

    act(() => result.current.openAll());

    expect(result.current.isOpen("a")).toBe(true);
    expect(result.current.isOpen("b")).toBe(true);
    expect(result.current.allOpen).toBe(true);
    expect(result.current.allClosed).toBe(false);
  });

  it("closeAll closes every current id and flips allOpen/allClosed", () => {
    const { result } = renderHook(() => useOpenMap(["a", "b"], true));

    act(() => result.current.closeAll());

    expect(result.current.isOpen("a")).toBe(false);
    expect(result.current.isOpen("b")).toBe(false);
    expect(result.current.allClosed).toBe(true);
    expect(result.current.allOpen).toBe(false);
  });

  it("empty ids resolve both allOpen and allClosed to false", () => {
    const { result } = renderHook(() => useOpenMap([], true));

    expect(result.current.allOpen).toBe(false);
    expect(result.current.allClosed).toBe(false);
  });

  it("after closeAll, an id added later falls back to its default instead of staying closed", () => {
    const { result, rerender } = renderHook(({ ids }) => useOpenMap(ids, true), {
      initialProps: { ids: ["a", "b"] as string[] },
    });

    act(() => result.current.closeAll());
    expect(result.current.isOpen("a")).toBe(false);
    expect(result.current.isOpen("b")).toBe(false);

    rerender({ ids: ["a", "b", "c"] });

    // "a" keeps its explicit closeAll entry ...
    expect(result.current.isOpen("a")).toBe(false);
    // ... but "c" never got one, so it falls back to defaultOpen.
    expect(result.current.isOpen("c")).toBe(true);
  });

  it("after openAll, an id added later falls back to its default instead of staying open", () => {
    const { result, rerender } = renderHook(({ ids }) => useOpenMap(ids, false), {
      initialProps: { ids: ["a"] as string[] },
    });

    act(() => result.current.openAll());
    expect(result.current.isOpen("a")).toBe(true);

    rerender({ ids: ["a", "b"] });

    expect(result.current.isOpen("a")).toBe(true);
    expect(result.current.isOpen("b")).toBe(false);
  });

  it("supports numeric ids", () => {
    const { result } = renderHook(() => useOpenMap([1, 2], false));

    act(() => result.current.toggle(1));

    expect(result.current.isOpen(1)).toBe(true);
    expect(result.current.isOpen(2)).toBe(false);
  });
});
