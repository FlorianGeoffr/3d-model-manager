import { describe, expect, it } from "vitest";

import { modelFilaments, revisionFormats } from "@/components/model-detail/modelSpec";
import type { FileOut, ModelDetail } from "@/api/types";

function detail(files: Array<Partial<FileOut>>): ModelDetail {
  return { current_revision: { files } } as unknown as ModelDetail;
}

describe("modelFilaments", () => {
  it("collects distinct (color, material) pairs across plate metadata", () => {
    const model = detail([
      {
        format: "3mf",
        meta: {
          plates: [
            { filaments: [{ color: "#ff0000", type: "PLA" }, { color: "#ff0000", type: "PLA" }] },
            { filaments: [{ color: "#00ff00", type: "PETG" }] },
          ],
        },
      } as unknown as FileOut,
      { format: "stl", meta: null } as unknown as FileOut,
    ]);

    expect(modelFilaments(model)).toEqual([
      { color: "#ff0000", material: "PLA" },
      { color: "#00ff00", material: "PETG" },
    ]);
  });

  it("skips empty filaments and handles a model with no current revision", () => {
    const empty = detail([
      { meta: { plates: [{ filaments: [{ color: null, type: null }] }] } } as unknown as FileOut,
    ]);
    expect(modelFilaments(empty)).toEqual([]);
    expect(modelFilaments({ current_revision: null } as ModelDetail)).toEqual([]);
  });
});

describe("revisionFormats", () => {
  it("returns the distinct formats in the current revision, first-seen order", () => {
    const model = detail([
      { format: "stl" } as FileOut,
      { format: "3mf" } as FileOut,
      { format: "stl" } as FileOut,
    ]);
    expect(revisionFormats(model)).toEqual(["stl", "3mf"]);
  });
});
