import { afterEach, describe, expect, it } from "vitest";

import {
  decodePartColors,
  encodePartColors,
  loadPartColors,
  savePartColors,
} from "@/components/viewer/partColors";

afterEach(() => localStorage.clear());

describe("encode/decode part colors", () => {
  it("round-trips a color map through the URL encoding", () => {
    const colors = { 1: "#ff0000", 42: "#00ff00" };
    expect(decodePartColors(encodePartColors(colors))).toEqual(colors);
  });

  it("encodes without the leading '#' and decodes it back", () => {
    expect(encodePartColors({ 7: "#abcdef" })).toBe("7:abcdef");
    expect(decodePartColors("7:abcdef")).toEqual({ 7: "#abcdef" });
  });

  it("drops malformed pairs on decode", () => {
    expect(decodePartColors("1:zzz,2:00ff00,bad")).toEqual({ 2: "#00ff00" });
    expect(decodePartColors("")).toEqual({});
    expect(decodePartColors(null)).toEqual({});
  });
});

describe("load/save part colors", () => {
  it("persists and reloads a model's colors, keyed by slug", () => {
    savePartColors("dragon", { 1: "#123456" });
    expect(loadPartColors("dragon")).toEqual({ 1: "#123456" });
    expect(loadPartColors("other")).toEqual({});
  });

  it("returns {} for absent or corrupt storage, dropping invalid entries", () => {
    expect(loadPartColors("missing")).toEqual({});
    localStorage.setItem("viewer-colors:corrupt", "not json");
    expect(loadPartColors("corrupt")).toEqual({});
    localStorage.setItem("viewer-colors:mixed", JSON.stringify({ 1: "#ff0000", 2: "nope" }));
    expect(loadPartColors("mixed")).toEqual({ 1: "#ff0000" });
  });
});
