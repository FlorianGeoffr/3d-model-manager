import { describe, expect, it } from "vitest";

import { isSlicerEligible, pickBestSlicerFile } from "@/lib/slicers";
import type { BlobFormat, FileOut } from "@/api/types";

function file(overrides: Partial<FileOut> & { id: number; format: BlobFormat }): FileOut {
  return {
    revision_id: 1,
    rel_path: `file-${overrides.id}.${overrides.format}`,
    storage_path: "",
    blob_hash: `hash-${overrides.id}`,
    size: 0,
    kind: "mesh",
    mtime: null,
    verified_at: "2026-01-01T00:00:00Z",
    meta: null,
    thumb_ready: false,
    glb_status: null,
    glb_preview_ready: false,
    ...overrides,
  };
}

describe("isSlicerEligible", () => {
  it("accepts stl/3mf/step/obj/iges/gcode_3mf/gcode", () => {
    for (const format of ["stl", "3mf", "step", "obj", "iges", "gcode_3mf", "gcode"] as const) {
      expect(isSlicerEligible(file({ id: 1, format }))).toBe(true);
    }
  });

  it("rejects non-slicer formats", () => {
    for (const format of ["png", "jpg", "other"] as const) {
      expect(isSlicerEligible(file({ id: 1, format }))).toBe(false);
    }
  });
});

describe("pickBestSlicerFile", () => {
  it("returns undefined when nothing is eligible", () => {
    expect(pickBestSlicerFile([file({ id: 1, format: "png" })])).toBeUndefined();
  });

  it("skips unverified files even if otherwise eligible", () => {
    expect(pickBestSlicerFile([file({ id: 1, format: "3mf", verified_at: null })])).toBeUndefined();
  });

  it("prefers 3mf over step/obj/stl/iges", () => {
    const files = [
      file({ id: 1, format: "stl" }),
      file({ id: 2, format: "obj" }),
      file({ id: 3, format: "3mf" }),
      file({ id: 4, format: "step" }),
      file({ id: 5, format: "iges" }),
    ];
    expect(pickBestSlicerFile(files)?.id).toBe(3);
  });

  it("falls back down the priority order when higher formats are absent", () => {
    expect(pickBestSlicerFile([file({ id: 1, format: "iges" }), file({ id: 2, format: "obj" })])?.id).toBe(2);
    expect(pickBestSlicerFile([file({ id: 1, format: "iges" }), file({ id: 2, format: "stl" })])?.id).toBe(2);
  });

  it("breaks ties within the same format by rel_path", () => {
    const files = [
      file({ id: 1, format: "stl", rel_path: "b.stl" }),
      file({ id: 2, format: "stl", rel_path: "a.stl" }),
    ];
    expect(pickBestSlicerFile(files)?.id).toBe(2);
  });
});
