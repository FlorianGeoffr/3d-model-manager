import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  LIGHTING_PRESET_LABELS,
  LIGHTING_PRESET_ORDER,
  resolveLighting,
  useViewerLighting,
  type LightingPreset,
} from "@/components/viewer/lighting";

afterEach(() => localStorage.clear());

describe("LIGHTING_PRESET_ORDER / LIGHTING_PRESET_LABELS", () => {
  it("lists studio, bright, flat in picker order, each with a label", () => {
    expect(LIGHTING_PRESET_ORDER).toEqual(["studio", "bright", "flat"]);
    for (const preset of LIGHTING_PRESET_ORDER) {
      expect(LIGHTING_PRESET_LABELS[preset]).toBeTruthy();
    }
  });
});

describe("resolveLighting", () => {
  it("resolves the studio rig", () => {
    expect(resolveLighting("studio")).toEqual({
      exposure: 1.0,
      ambient: 0.25,
      key: 1.6,
      fill: 0.55,
      rim: 0.9,
      env: 0.85,
      contactShadow: true,
    });
  });

  it("resolves the bright rig", () => {
    expect(resolveLighting("bright")).toEqual({
      exposure: 1.25,
      ambient: 0.55,
      key: 2.0,
      fill: 0.9,
      rim: 1.1,
      env: 1.1,
      contactShadow: true,
    });
  });

  it("resolves the flat rig", () => {
    expect(resolveLighting("flat")).toEqual({
      exposure: 1.0,
      ambient: 1.1,
      key: 0.6,
      fill: 0.6,
      rim: 0.3,
      env: 0.35,
      contactShadow: false,
    });
  });

  it("only flat has contactShadow disabled -- studio and bright both cast one", () => {
    expect(resolveLighting("studio").contactShadow).toBe(true);
    expect(resolveLighting("bright").contactShadow).toBe(true);
    expect(resolveLighting("flat").contactShadow).toBe(false);
  });

  it("falls back to the studio rig for an unknown preset string", () => {
    expect(resolveLighting("neon" as LightingPreset)).toEqual(resolveLighting("studio"));
  });
});

describe("useViewerLighting", () => {
  it("defaults to studio when nothing is persisted", () => {
    const { result } = renderHook(() => useViewerLighting());
    expect(result.current.preset).toBe("studio");
    expect(result.current.rig).toEqual(resolveLighting("studio"));
  });

  it("restores a previously persisted preset on mount", () => {
    localStorage.setItem("viewer-lighting", "bright");
    const { result } = renderHook(() => useViewerLighting());
    expect(result.current.preset).toBe("bright");
    expect(result.current.rig).toEqual(resolveLighting("bright"));
  });

  it("falls back to studio for a corrupt/unknown persisted value", () => {
    localStorage.setItem("viewer-lighting", "not-a-real-preset");
    const { result } = renderHook(() => useViewerLighting());
    expect(result.current.preset).toBe("studio");
  });

  it("persists changes made through setPreset", () => {
    const { result } = renderHook(() => useViewerLighting());

    act(() => result.current.setPreset("flat"));

    expect(result.current.preset).toBe("flat");
    expect(localStorage.getItem("viewer-lighting")).toBe("flat");
  });

  it("seeds from the `initial` argument instead of localStorage when given", () => {
    localStorage.setItem("viewer-lighting", "flat");
    const { result } = renderHook(() => useViewerLighting("bright"));
    expect(result.current.preset).toBe("bright");
  });

  it("degrades an invalid `initial` to the studio default", () => {
    const { result } = renderHook(() => useViewerLighting("neon" as LightingPreset));
    expect(result.current.preset).toBe("studio");
  });
});
