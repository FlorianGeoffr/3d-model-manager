import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FileRail, isSameSelection, type StudioSelection } from "@/components/model-detail/FileRail";
import type { FileOut } from "@/api/types";

function fakeFile(overrides: Partial<FileOut> & { id: number }): FileOut {
  return {
    revision_id: 1,
    rel_path: `file-${overrides.id}.stl`,
    storage_path: "",
    blob_hash: `hash-${overrides.id}`,
    size: 1024,
    format: "stl",
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

describe("isSameSelection", () => {
  it("matches assembly to assembly and file ids to themselves", () => {
    expect(isSameSelection({ type: "assembly" }, { type: "assembly" })).toBe(true);
    expect(isSameSelection({ type: "file", id: 1 }, { type: "file", id: 1 })).toBe(true);
    expect(isSameSelection({ type: "file", id: 1 }, { type: "file", id: 2 })).toBe(false);
    expect(isSameSelection({ type: "assembly" }, { type: "file", id: 1 })).toBe(false);
    expect(isSameSelection(undefined, { type: "assembly" })).toBe(false);
  });
});

describe("FileRail", () => {
  it("renders a synthetic Assembly entry only when glb files are present", () => {
    render(
      <FileRail
        glbFiles={[]}
        otherFiles={[fakeFile({ id: 1, kind: "sliced" })]}
        selection={{ type: "file", id: 1 }}
        onSelect={vi.fn()}
        checkedIds={new Set()}
        onToggleFile={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Assembly/)).not.toBeInTheDocument();
  });

  it("shows the part count in the Assembly entry label", () => {
    const glbFiles = [fakeFile({ id: 1, glb_status: "ok" }), fakeFile({ id: 2, glb_status: "ok" })];
    render(
      <FileRail
        glbFiles={glbFiles}
        otherFiles={[]}
        selection={{ type: "assembly" }}
        onSelect={vi.fn()}
        checkedIds={new Set([1])}
        onToggleFile={vi.fn()}
      />,
    );
    expect(screen.getByText("Assembly (2 parts)")).toBeInTheDocument();
  });

  it("expands per-part visibility checkboxes only when the Assembly entry is selected", () => {
    const glbFiles = [
      fakeFile({ id: 1, rel_path: "a.stl", glb_status: "ok" }),
      fakeFile({ id: 2, rel_path: "b.stl", glb_status: "ok" }),
    ];
    const { rerender } = render(
      <FileRail
        glbFiles={glbFiles}
        otherFiles={[]}
        selection={{ type: "file", id: 999 }}
        onSelect={vi.fn()}
        checkedIds={new Set([1])}
        onToggleFile={vi.fn()}
      />,
    );
    expect(screen.queryByRole("checkbox", { name: "a.stl" })).not.toBeInTheDocument();

    rerender(
      <FileRail
        glbFiles={glbFiles}
        otherFiles={[]}
        selection={{ type: "assembly" }}
        onSelect={vi.fn()}
        checkedIds={new Set([1])}
        onToggleFile={vi.fn()}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "a.stl" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "b.stl" })).not.toBeChecked();
  });

  it("toggling a part checkbox calls onToggleFile with the file id and next checked state", () => {
    const onToggleFile = vi.fn();
    const glbFiles = [fakeFile({ id: 1, rel_path: "a.stl", glb_status: "ok" })];
    render(
      <FileRail
        glbFiles={glbFiles}
        otherFiles={[]}
        selection={{ type: "assembly" }}
        onSelect={vi.fn()}
        checkedIds={new Set([1])}
        onToggleFile={onToggleFile}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "a.stl" }));
    expect(onToggleFile).toHaveBeenCalledWith(1, false);
  });

  it("clicking the Assembly entry selects it", () => {
    const onSelect = vi.fn();
    const glbFiles = [fakeFile({ id: 1, glb_status: "ok" })];
    render(
      <FileRail
        glbFiles={glbFiles}
        otherFiles={[]}
        selection={undefined}
        onSelect={onSelect}
        checkedIds={new Set()}
        onToggleFile={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Assembly/ }));
    expect(onSelect).toHaveBeenCalledWith({ type: "assembly" } satisfies StudioSelection);
  });

  it("shows format + status chips for other files and selects them on click", () => {
    const onSelect = vi.fn();
    const pending = fakeFile({ id: 1, rel_path: "pending.stl", glb_status: "pending" });
    const failed = fakeFile({ id: 2, rel_path: "failed.stl", glb_status: "failed" });
    const unsupported = fakeFile({ id: 3, rel_path: "weird.step", format: "step", glb_status: "unsupported" });
    const sliced = fakeFile({ id: 4, rel_path: "plate.gcode.3mf", format: "3mf", kind: "sliced" });
    const gcode = fakeFile({ id: 5, rel_path: "plain.gcode", format: "gcode", kind: "gcode" });
    render(
      <FileRail
        glbFiles={[]}
        otherFiles={[pending, failed, unsupported, sliced, gcode]}
        selection={{ type: "file", id: 1 }}
        onSelect={onSelect}
        checkedIds={new Set()}
        onToggleFile={vi.fn()}
      />,
    );

    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("No preview")).toBeInTheDocument();
    expect(screen.getByText("Sliced")).toBeInTheDocument();
    // "G-code" is both the format label and the status chip for the plain
    // gcode file -- both appear.
    expect(screen.getAllByText("G-code")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /failed\.stl/ }));
    expect(onSelect).toHaveBeenCalledWith({ type: "file", id: 2 } satisfies StudioSelection);
  });
});
