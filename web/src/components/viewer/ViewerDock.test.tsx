import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ViewerDock } from "@/components/viewer/ViewerDock";
import { DEFAULT_TOOLS } from "@/components/viewer/tools";
import { QUICK_COLORS } from "@/components/viewer/quickColors";

describe("ViewerDock", () => {
  it("camera preset segmented control calls onToolsChange with cameraPreset", () => {
    const onToolsChange = vi.fn();
    render(
      <ViewerDock tools={DEFAULT_TOOLS} onToolsChange={onToolsChange} checkedList={[1]} onQuickColor={vi.fn()} morePanel={null} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Top" }));
    expect(onToolsChange).toHaveBeenCalledWith({ cameraPreset: "top" });
  });

  it("shading segmented control (Solid/Wire/X-Ray) replaces the old Wireframe/X-ray toggle buttons", () => {
    const onToolsChange = vi.fn();
    render(
      <ViewerDock tools={DEFAULT_TOOLS} onToolsChange={onToolsChange} checkedList={[1]} onQuickColor={vi.fn()} morePanel={null} />,
    );
    expect(screen.getByRole("radio", { name: "Solid" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Wire" }));
    expect(onToolsChange).toHaveBeenCalledWith({ shading: "wireframe" });
    fireEvent.click(screen.getByRole("radio", { name: "X-Ray" }));
    expect(onToolsChange).toHaveBeenCalledWith({ shading: "xray" });
  });

  it("renders all 7 quick-color swatches and calls onQuickColor with the hex, disabled when nothing is checked", () => {
    const onQuickColor = vi.fn();
    const { rerender } = render(
      <ViewerDock tools={DEFAULT_TOOLS} onToolsChange={vi.fn()} checkedList={[]} onQuickColor={onQuickColor} morePanel={null} />,
    );
    const swatches = QUICK_COLORS.map((hex) => screen.getByRole("button", { name: `Paint checked parts ${hex}` }));
    expect(swatches).toHaveLength(7);
    for (const swatch of swatches) expect(swatch).toBeDisabled();

    rerender(
      <ViewerDock tools={DEFAULT_TOOLS} onToolsChange={vi.fn()} checkedList={[1]} onQuickColor={onQuickColor} morePanel={null} />,
    );
    fireEvent.click(screen.getByRole("button", { name: `Paint checked parts ${QUICK_COLORS[0]}` }));
    expect(onQuickColor).toHaveBeenCalledWith(QUICK_COLORS[0]);
  });

  it("Grid toggle preserves the legacy 'Grid' aria-label and pressed state", () => {
    const onToolsChange = vi.fn();
    render(
      <ViewerDock tools={DEFAULT_TOOLS} onToolsChange={onToolsChange} checkedList={[]} onQuickColor={vi.fn()} morePanel={null} />,
    );
    const grid = screen.getByRole("button", { name: "Grid" });
    expect(grid).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(grid);
    expect(onToolsChange).toHaveBeenCalledWith({ grid: false });
  });

  it("renders the morePanel slot", () => {
    render(
      <ViewerDock
        tools={DEFAULT_TOOLS}
        onToolsChange={vi.fn()}
        checkedList={[]}
        onQuickColor={vi.fn()}
        morePanel={<button type="button">More trigger stub</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "More trigger stub" })).toBeInTheDocument();
  });
});
