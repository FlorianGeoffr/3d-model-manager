import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ViewerTopOverlay } from "@/components/viewer/ViewerTopOverlay";
import type { FileOut } from "@/api/types";

// Radix's Popover never reaches an interactive open state under jsdom (same
// convention as `LibraryPage.test.tsx`'s Collection/Tags facets) -- render
// trigger/content unconditionally so the Parts popover's rows are reachable
// without a real open click.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

function fakeFile(overrides: Partial<FileOut> & { id: number }): FileOut {
  return {
    revision_id: 1,
    rel_path: `part-${overrides.id}.stl`,
    storage_path: "",
    blob_hash: `hash-${overrides.id}`,
    size: 1024,
    format: "stl",
    kind: "mesh",
    mtime: null,
    verified_at: "2026-01-01T00:00:00Z",
    meta: null,
    thumb_ready: false,
    glb_status: "ok",
    glb_preview_ready: true,
    ...overrides,
  };
}

function baseProps() {
  return {
    stats: null,
    files: [fakeFile({ id: 1 }), fakeFile({ id: 2 })],
    checkedIds: new Set<number>([1]),
    onToggleFile: vi.fn(),
    onSetAllChecked: vi.fn(),
    colors: {},
    onSetPartColor: vi.fn(),
    onClearPartColor: vi.fn(),
    autoRotate: false,
    onToggleAutoRotate: vi.fn(),
    onCaptureCover: vi.fn(),
    capturingCover: false,
    canCaptureCover: true,
    isFullscreen: false,
    onToggleFullscreen: vi.fn(),
    container: null,
  };
}

describe("ViewerTopOverlay", () => {
  it("shows the dims pill from stats, formatted", () => {
    render(<ViewerTopOverlay {...baseProps()} stats={{ x: 10, y: 20, z: 5, triangles: 1234 }} />);
    expect(screen.getByText(/10\.0 × 20\.0 × 5\.0 mm/)).toBeInTheDocument();
  });

  it("exposes the Parts popover's checklist rows with the legacy aria-labels", () => {
    render(<ViewerTopOverlay {...baseProps()} />);

    expect(screen.getByRole("button", { name: "Show all parts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "None — hide all parts" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "part-1.stl" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "part-2.stl" })).not.toBeChecked();
    expect(screen.getByLabelText("Color for part-1.stl")).toBeInTheDocument();
  });

  it("toggling a part checkbox calls onToggleFile", () => {
    const onToggleFile = vi.fn();
    render(<ViewerTopOverlay {...baseProps()} onToggleFile={onToggleFile} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "part-2.stl" }));
    expect(onToggleFile).toHaveBeenCalledWith(2, true);
  });

  it("Spin toggles auto-rotate", () => {
    const onToggleAutoRotate = vi.fn();
    render(<ViewerTopOverlay {...baseProps()} onToggleAutoRotate={onToggleAutoRotate} />);
    fireEvent.click(screen.getByRole("button", { name: "Auto-rotate" }));
    expect(onToggleAutoRotate).toHaveBeenCalled();
  });

  it("Cover is disabled when canCaptureCover is false, else calls onCaptureCover", () => {
    const onCaptureCover = vi.fn();
    const { rerender } = render(
      <ViewerTopOverlay {...baseProps()} canCaptureCover={false} onCaptureCover={onCaptureCover} />,
    );
    expect(screen.getByRole("button", { name: "Cover" })).toBeDisabled();

    rerender(<ViewerTopOverlay {...baseProps()} canCaptureCover onCaptureCover={onCaptureCover} />);
    fireEvent.click(screen.getByRole("button", { name: "Cover" }));
    expect(onCaptureCover).toHaveBeenCalled();
  });

  it("Fullscreen calls onToggleFullscreen and reflects isFullscreen", () => {
    const onToggleFullscreen = vi.fn();
    render(<ViewerTopOverlay {...baseProps()} isFullscreen onToggleFullscreen={onToggleFullscreen} />);
    const button = screen.getByRole("button", { name: "Fullscreen" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(onToggleFullscreen).toHaveBeenCalled();
  });
});
