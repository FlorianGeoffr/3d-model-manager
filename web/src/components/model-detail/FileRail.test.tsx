import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FileRail, isSameSelection, type StudioSelection } from "@/components/model-detail/FileRail";
import type { PartColors } from "@/components/viewer/partColors";
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

/** Shared no-op defaults for the color-related props -- most tests here
 * don't exercise recoloring, so only the tests that do override them. */
function baseProps(colors: PartColors = {}) {
  return {
    checkedIds: new Set<number>(),
    onToggleFile: vi.fn(),
    onSetAllChecked: vi.fn(),
    colors,
    onSetPartColor: vi.fn(),
    onClearPartColor: vi.fn(),
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
        {...baseProps()}
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
        {...baseProps()}
        checkedIds={new Set([1])}
      />,
    );
    expect(screen.getByText("Assembly (2 parts)")).toBeInTheDocument();
  });

  it("shows the checked-count and wires All/None to onSetAllChecked, regardless of whether Assembly is expanded", () => {
    const onSetAllChecked = vi.fn();
    const glbFiles = [fakeFile({ id: 1, glb_status: "ok" }), fakeFile({ id: 2, glb_status: "ok" })];
    render(
      <FileRail
        glbFiles={glbFiles}
        otherFiles={[]}
        selection={{ type: "file", id: 999 }}
        onSelect={vi.fn()}
        {...baseProps()}
        checkedIds={new Set([1])}
        onSetAllChecked={onSetAllChecked}
      />,
    );

    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all parts" }));
    expect(onSetAllChecked).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "None — hide all parts" }));
    expect(onSetAllChecked).toHaveBeenCalledWith(false);
  });

  it("disables All when every part is checked and None when none are", () => {
    const glbFiles = [fakeFile({ id: 1, glb_status: "ok" }), fakeFile({ id: 2, glb_status: "ok" })];
    render(
      <FileRail
        glbFiles={glbFiles}
        otherFiles={[]}
        selection={{ type: "assembly" }}
        onSelect={vi.fn()}
        {...baseProps()}
        checkedIds={new Set([1, 2])}
      />,
    );
    expect(screen.getByRole("button", { name: "Show all parts" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "None — hide all parts" })).not.toBeDisabled();
  });

  it("expands per-part visibility checkboxes and color swatches only when the Assembly entry is selected", () => {
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
        {...baseProps()}
        checkedIds={new Set([1])}
      />,
    );
    expect(screen.queryByRole("checkbox", { name: "a.stl" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Color for a.stl")).not.toBeInTheDocument();

    rerender(
      <FileRail
        glbFiles={glbFiles}
        otherFiles={[]}
        selection={{ type: "assembly" }}
        onSelect={vi.fn()}
        {...baseProps()}
        checkedIds={new Set([1])}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "a.stl" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "b.stl" })).not.toBeChecked();
    expect(screen.getByLabelText("Color for a.stl")).toBeInTheDocument();
    expect(screen.getByLabelText("Color for b.stl")).toBeInTheDocument();
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
        {...baseProps()}
        checkedIds={new Set([1])}
        onToggleFile={onToggleFile}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "a.stl" }));
    expect(onToggleFile).toHaveBeenCalledWith(1, false);
  });

  it("recoloring a part's swatch calls onSetPartColor, and its reset button calls onClearPartColor", () => {
    const onSetPartColor = vi.fn();
    const onClearPartColor = vi.fn();
    const glbFiles = [fakeFile({ id: 1, rel_path: "a.stl", glb_status: "ok" })];
    const { rerender } = render(
      <FileRail
        glbFiles={glbFiles}
        otherFiles={[]}
        selection={{ type: "assembly" }}
        onSelect={vi.fn()}
        {...baseProps()}
        onSetPartColor={onSetPartColor}
        onClearPartColor={onClearPartColor}
      />,
    );

    expect(screen.queryByRole("button", { name: "Reset color for a.stl" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Color for a.stl"), { target: { value: "#123456" } });
    expect(onSetPartColor).toHaveBeenCalledWith(1, "#123456");

    // Once a color is set, a reset button appears (mirrors the color back
    // in via `colors`, since this component doesn't own that state itself).
    rerender(
      <FileRail
        glbFiles={glbFiles}
        otherFiles={[]}
        selection={{ type: "assembly" }}
        onSelect={vi.fn()}
        {...baseProps({ 1: "#123456" })}
        onSetPartColor={onSetPartColor}
        onClearPartColor={onClearPartColor}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset color for a.stl" }));
    expect(onClearPartColor).toHaveBeenCalledWith(1);
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
        {...baseProps()}
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
        {...baseProps()}
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
