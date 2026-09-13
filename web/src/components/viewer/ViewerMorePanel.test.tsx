import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ViewerMorePanel, type ViewerMorePanelProps } from "@/components/viewer/ViewerMorePanel";
import { DEFAULT_TOOLS } from "@/components/viewer/tools";

// Radix's Popover/Dialog(Sheet) never reach an interactive open state under
// jsdom (same convention as `LibraryPage.test.tsx`) -- render trigger/
// content unconditionally, tagged so the test can tell which shell (Popover
// vs Sheet) `ViewerMorePanel` picked for the current viewport width.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children?: ReactNode }) => <div data-testid="popover-shell">{children}</div>,
  PopoverTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children?: ReactNode }) => <div data-testid="sheet-shell">{children}</div>,
  SheetTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SheetContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("@/api/printers", () => ({
  usePrinterStatus: () => ({ data: undefined }),
}));

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
  act(() => window.dispatchEvent(new Event("resize")));
}

function baseProps(): ViewerMorePanelProps {
  return {
    preset: "studio",
    custom: "#a1a1aa",
    onPresetChange: vi.fn(),
    onCustomChange: vi.fn(),
    lightingPreset: "studio",
    onLightingChange: vi.fn(),
    tools: DEFAULT_TOOLS,
    onToolsChange: vi.fn(),
    explodeMode: "explode",
    onFit: vi.fn(),
    onScreenshot: vi.fn(),
    hasColors: true,
    onResetColors: vi.fn(),
    printerId: undefined,
    checkedList: [1, 2],
    onApplyAmsColors: vi.fn(),
    onOpenWindow: vi.fn(),
    showWindowButtons: true,
    container: null,
  };
}

describe("ViewerMorePanel", () => {
  afterEach(() => setViewportWidth(1024));

  it("uses the Popover shell at >=900px and the Sheet shell below it", () => {
    setViewportWidth(1024);
    const { rerender } = render(<ViewerMorePanel {...baseProps()} />);
    expect(screen.getByTestId("popover-shell")).toBeInTheDocument();
    expect(screen.queryByTestId("sheet-shell")).not.toBeInTheDocument();

    setViewportWidth(500);
    rerender(<ViewerMorePanel {...baseProps()} />);
    expect(screen.getByTestId("sheet-shell")).toBeInTheDocument();
  });

  it("every legacy control is reachable: Background, Lighting, Section, Explode, Ortho, Fit, Auto-rotate, Screenshot, Reset colors, New window/Parts in windows", () => {
    render(<ViewerMorePanel {...baseProps()} tools={{ ...DEFAULT_TOOLS, section: { enabled: true, axis: "x", t: 0.5 } }} />);

    expect(screen.getByRole("radiogroup", { name: "Background" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Lighting" })).toBeInTheDocument();
    expect(screen.getByLabelText("Section position")).toBeInTheDocument();
    expect(screen.getByLabelText("Explode")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Orthographic camera" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fit view" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Auto-rotate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Screenshot" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reset colors/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New window/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Parts in windows" })).toBeInTheDocument();
    expect(screen.getByText(/Hotkeys/)).toBeInTheDocument();
  });

  it("Fit view calls onFit; Screenshot calls onScreenshot; Reset colors calls onResetColors", () => {
    const onFit = vi.fn();
    const onScreenshot = vi.fn();
    const onResetColors = vi.fn();
    render(<ViewerMorePanel {...baseProps()} onFit={onFit} onScreenshot={onScreenshot} onResetColors={onResetColors} />);

    fireEvent.click(screen.getByRole("button", { name: "Fit view" }));
    expect(onFit).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Screenshot" }));
    expect(onScreenshot).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Reset colors/ }));
    expect(onResetColors).toHaveBeenCalled();
  });

  it("Ortho toggles tools.ortho and refits; Auto-rotate toggles tools.autoRotate", () => {
    const onToolsChange = vi.fn();
    const onFit = vi.fn();
    render(<ViewerMorePanel {...baseProps()} onToolsChange={onToolsChange} onFit={onFit} />);

    fireEvent.click(screen.getByRole("button", { name: "Orthographic camera" }));
    expect(onToolsChange).toHaveBeenCalledWith({ ortho: true });
    expect(onFit).toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Auto-rotate" }));
    expect(onToolsChange).toHaveBeenCalledWith({ autoRotate: true });
  });

  it("hides the Explode/Separate slider when explodeMode is none", () => {
    render(<ViewerMorePanel {...baseProps()} explodeMode="none" />);
    expect(screen.queryByLabelText("Explode")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Separate parts")).not.toBeInTheDocument();
  });

  it("does not show New window/Parts in windows when showWindowButtons is false", () => {
    render(<ViewerMorePanel {...baseProps()} showWindowButtons={false} />);
    expect(screen.queryByRole("button", { name: /New window/ })).not.toBeInTheDocument();
  });
});
