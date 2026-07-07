import { describe, expect, it } from "vitest";
import { detectSite } from "@/lib/importSites";

describe("detectSite", () => {
  it("detects thingiverse + printables as supported", () => {
    expect(detectSite("https://www.thingiverse.com/thing:763622")).toMatchObject({ site: "thingiverse", supported: true });
    expect(detectSite("https://printables.com/model/3161-benchy")).toMatchObject({ site: "printables", supported: true });
  });
  it("detects makerworld as recognized-but-unsupported", () => {
    expect(detectSite("https://makerworld.com/en/models/1")).toMatchObject({ site: "makerworld", supported: false });
  });
  it("returns null for unknown or invalid", () => {
    expect(detectSite("https://example.com/x").site).toBeNull();
    expect(detectSite("not a url").site).toBeNull();
  });
});
