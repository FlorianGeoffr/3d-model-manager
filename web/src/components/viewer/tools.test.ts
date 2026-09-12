import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_TOOLS, formatStats, sectionPlaneParams, useViewerTools } from "@/components/viewer/tools";

afterEach(() => localStorage.clear());

describe("DEFAULT_TOOLS", () => {
  it("defaults the grid on and every other tool off/neutral", () => {
    expect(DEFAULT_TOOLS).toEqual({
      grid: true,
      wireframe: false,
      autoRotate: false,
      ortho: false,
      section: { enabled: false, axis: "x", t: 0.5 },
      explode: 0,
      cameraPreset: null,
    });
  });
});

describe("formatStats", () => {
  it("formats dims to 1 decimal and a sub-1k triangle count with no suffix", () => {
    expect(formatStats({ x: 220.4, y: 180, z: 45.2, triangles: 842 })).toBe(
      "220.4 × 180.0 × 45.2 mm · 842 tris",
    );
  });

  it("humanizes a thousands-range triangle count with a 'k' suffix", () => {
    expect(formatStats({ x: 10, y: 10, z: 10, triangles: 12_400 })).toBe(
      "10.0 × 10.0 × 10.0 mm · 12.4k tris",
    );
  });

  it("humanizes a millions-range triangle count with an 'M' suffix", () => {
    expect(formatStats({ x: 220.4, y: 180, z: 45.2, triangles: 1_200_000 })).toBe(
      "220.4 × 180.0 × 45.2 mm · 1.2M tris",
    );
  });

  it("rounds the M suffix to 1 decimal rather than truncating", () => {
    expect(formatStats({ x: 1, y: 1, z: 1, triangles: 1_249_000 }).endsWith("1.2M tris")).toBe(true);
    expect(formatStats({ x: 1, y: 1, z: 1, triangles: 1_260_000 }).endsWith("1.3M tris")).toBe(true);
  });

  it("rounds a sub-1k count to the nearest integer", () => {
    expect(formatStats({ x: 1, y: 1, z: 1, triangles: 999.6 }).endsWith("1000 tris")).toBe(true);
  });
});

describe("sectionPlaneParams", () => {
  // A size where every axis has a distinct dimension (10/20/30 mm) and a
  // non-1 scale factor (2), so a mixed-up axis or an unscaled extent would
  // fail these assertions rather than passing by coincidence.
  const size = { x: 10, y: 20, z: 30 };
  const s = 2;

  it("x axis: centered around the origin, normal points in -x", () => {
    expect(sectionPlaneParams({ enabled: true, axis: "x", t: 0 }, size, s)).toEqual({
      normal: [-1, 0, 0],
      constant: -10,
    });
    expect(sectionPlaneParams({ enabled: true, axis: "x", t: 0.5 }, size, s)).toEqual({
      normal: [-1, 0, 0],
      constant: 0,
    });
    expect(sectionPlaneParams({ enabled: true, axis: "x", t: 1 }, size, s)).toEqual({
      normal: [-1, 0, 0],
      constant: 10,
    });
  });

  it("y axis: grounded at 0 (not centered), normal points in -y", () => {
    expect(sectionPlaneParams({ enabled: true, axis: "y", t: 0 }, size, s)).toEqual({
      normal: [0, -1, 0],
      constant: 0,
    });
    expect(sectionPlaneParams({ enabled: true, axis: "y", t: 0.5 }, size, s)).toEqual({
      normal: [0, -1, 0],
      constant: 20,
    });
    expect(sectionPlaneParams({ enabled: true, axis: "y", t: 1 }, size, s)).toEqual({
      normal: [0, -1, 0],
      constant: 40,
    });
  });

  it("z axis: centered around the origin, normal points in -z", () => {
    expect(sectionPlaneParams({ enabled: true, axis: "z", t: 0 }, size, s)).toEqual({
      normal: [0, 0, -1],
      constant: -30,
    });
    expect(sectionPlaneParams({ enabled: true, axis: "z", t: 0.5 }, size, s)).toEqual({
      normal: [0, 0, -1],
      constant: 0,
    });
    expect(sectionPlaneParams({ enabled: true, axis: "z", t: 1 }, size, s)).toEqual({
      normal: [0, 0, -1],
      constant: 30,
    });
  });
});

describe("useViewerTools", () => {
  it("defaults to DEFAULT_TOOLS when nothing is persisted and no initial is given", () => {
    const { result } = renderHook(() => useViewerTools());
    expect(result.current.tools).toEqual(DEFAULT_TOOLS);
  });

  it("restores a previously persisted grid value on mount", () => {
    localStorage.setItem("viewer-tools", JSON.stringify({ grid: false }));
    const { result } = renderHook(() => useViewerTools());
    expect(result.current.tools.grid).toBe(false);
    // Everything else still comes from the default -- only grid is stored.
    expect(result.current.tools.wireframe).toBe(false);
    expect(result.current.tools.explode).toBe(0);
  });

  it("falls back to the default grid value for a corrupt/invalid persisted value", () => {
    localStorage.setItem("viewer-tools", "not json");
    const { result: result1 } = renderHook(() => useViewerTools());
    expect(result1.current.tools.grid).toBe(true);

    localStorage.setItem("viewer-tools", JSON.stringify({ grid: "yes" }));
    const { result: result2 } = renderHook(() => useViewerTools());
    expect(result2.current.tools.grid).toBe(true);
  });

  it("setTools merges a patch instead of replacing the whole state", () => {
    const { result } = renderHook(() => useViewerTools());

    act(() => result.current.setTools({ wireframe: true }));

    expect(result.current.tools.wireframe).toBe(true);
    expect(result.current.tools.grid).toBe(true);
    expect(result.current.tools.autoRotate).toBe(false);
  });

  it("persists only `grid`: patching wireframe leaves localStorage untouched", () => {
    const { result } = renderHook(() => useViewerTools());

    act(() => result.current.setTools({ wireframe: true, autoRotate: true, explode: 0.5 }));

    expect(localStorage.getItem("viewer-tools")).toBeNull();
  });

  describe("cameraPreset transitions", () => {
    it("selects a preset and a later selection replaces it", () => {
      const { result } = renderHook(() => useViewerTools());
      expect(result.current.tools.cameraPreset).toBeNull();

      act(() => result.current.setTools({ cameraPreset: "top" }));
      expect(result.current.tools.cameraPreset).toBe("top");

      act(() => result.current.setTools({ cameraPreset: "front" }));
      expect(result.current.tools.cameraPreset).toBe("front");
    });

    it("a user orbit clears the preset back to null", () => {
      const { result } = renderHook(() => useViewerTools());
      act(() => result.current.setTools({ cameraPreset: "side" }));
      expect(result.current.tools.cameraPreset).toBe("side");

      // `ModelViewer`'s `OrbitPresetGuard` reports a real user orbit as
      // exactly this patch -- the segmented control must not keep showing a
      // preset as selected once the camera has actually moved off it.
      act(() => result.current.setTools({ cameraPreset: null }));
      expect(result.current.tools.cameraPreset).toBeNull();
    });
  });

  it("persists a grid change to localStorage", () => {
    const { result } = renderHook(() => useViewerTools());

    act(() => result.current.setTools({ grid: false }));

    expect(JSON.parse(localStorage.getItem("viewer-tools") ?? "{}")).toEqual({ grid: false });
  });

  it("persist=false never writes grid changes to localStorage", () => {
    const { result } = renderHook(() => useViewerTools(undefined, false));

    act(() => result.current.setTools({ grid: false }));

    expect(localStorage.getItem("viewer-tools")).toBeNull();
  });

  it("seeds from `initial` instead of localStorage when given", () => {
    localStorage.setItem("viewer-tools", JSON.stringify({ grid: false }));
    const { result } = renderHook(() => useViewerTools({ grid: true, explode: 0.3 }));

    expect(result.current.tools.grid).toBe(true);
    expect(result.current.tools.explode).toBe(0.3);
  });

  it("falls back to the stored grid value when `initial` doesn't specify grid", () => {
    localStorage.setItem("viewer-tools", JSON.stringify({ grid: false }));
    const { result } = renderHook(() => useViewerTools({ wireframe: true }));

    expect(result.current.tools.grid).toBe(false);
    expect(result.current.tools.wireframe).toBe(true);
  });
});
