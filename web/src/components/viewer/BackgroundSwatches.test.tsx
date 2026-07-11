import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";

import { BackgroundSwatches } from "@/components/viewer/BackgroundSwatches";
import { DEFAULT_CUSTOM_COLOR, type BackgroundPreset } from "@/components/viewer/background";

// Same rationale as `SegmentedControl.test.tsx`'s harness: `BackgroundSwatches`
// is controlled, and exercising the roving-tabindex/arrow-key contract needs a
// real re-render (focus has to land on the newly-selected swatch), not just a
// spy -- so drive it through a small stateful harness, the same way
// `ViewerTab` drives the real control.
function Harness({
  initialPreset = "studio",
  onPresetChange,
  onCustomChange,
}: {
  initialPreset?: BackgroundPreset;
  onPresetChange?: (next: BackgroundPreset) => void;
  onCustomChange?: (next: string) => void;
}) {
  const [preset, setPreset] = useState<BackgroundPreset>(initialPreset);
  const [custom, setCustom] = useState(DEFAULT_CUSTOM_COLOR);
  return (
    <BackgroundSwatches
      preset={preset}
      custom={custom}
      onPresetChange={(next) => {
        setPreset(next);
        onPresetChange?.(next);
      }}
      onCustomChange={(next) => {
        setCustom(next);
        onCustomChange?.(next);
      }}
    />
  );
}

/** The custom swatch's color input is deliberately unlabelled (`aria-hidden`)
 * so it doesn't add a second tab stop alongside its wrapping `role="radio"`
 * swatch -- reach it by DOM position instead of an accessible query. */
function customColorInput(): HTMLInputElement {
  const radio = screen.getByRole("radio", { name: "Custom" });
  const input = radio.querySelector('input[type="color"]');
  if (!input) throw new Error("custom color input not found");
  return input as HTMLInputElement;
}

describe("BackgroundSwatches", () => {
  it("renders a labelled radiogroup of 5 swatches, one checked", () => {
    render(<Harness />);

    expect(screen.getByRole("radiogroup", { name: "Background" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(5);
    expect(screen.getByRole("radio", { name: "Studio" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "White" })).toHaveAttribute("aria-checked", "false");
  });

  it("clicking a swatch calls onPresetChange with that option", () => {
    const onPresetChange = vi.fn();
    render(<Harness onPresetChange={onPresetChange} />);

    fireEvent.click(screen.getByRole("radio", { name: "White" }));

    expect(onPresetChange).toHaveBeenCalledWith("white");
  });

  it("ArrowRight moves focus and selection to the next option", () => {
    render(<Harness />);

    fireEvent.keyDown(screen.getByRole("radio", { name: "Studio" }), { key: "ArrowRight" });

    const white = screen.getByRole("radio", { name: "White" });
    expect(white).toHaveAttribute("aria-checked", "true");
    expect(white).toHaveFocus();
  });

  it("ArrowRight from the last option (Custom) wraps to the first (Studio)", () => {
    render(<Harness initialPreset="custom" />);

    fireEvent.keyDown(screen.getByRole("radio", { name: "Custom" }), { key: "ArrowRight" });

    const studio = screen.getByRole("radio", { name: "Studio" });
    expect(studio).toHaveAttribute("aria-checked", "true");
    expect(studio).toHaveFocus();
  });

  it("ArrowLeft from the first option (Studio) wraps to the last (Custom)", () => {
    render(<Harness />);

    fireEvent.keyDown(screen.getByRole("radio", { name: "Studio" }), { key: "ArrowLeft" });

    const custom = screen.getByRole("radio", { name: "Custom" });
    expect(custom).toHaveAttribute("aria-checked", "true");
    expect(custom).toHaveFocus();
  });

  it("ArrowDown/ArrowUp behave the same as ArrowRight/ArrowLeft", () => {
    render(<Harness initialPreset="white" />);

    fireEvent.keyDown(screen.getByRole("radio", { name: "White" }), { key: "ArrowDown" });
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(screen.getByRole("radio", { name: "Dark" }), { key: "ArrowUp" });
    expect(screen.getByRole("radio", { name: "White" })).toHaveAttribute("aria-checked", "true");
  });

  it("Home and End jump to the first and last option", () => {
    render(<Harness initialPreset="white" />);

    fireEvent.keyDown(screen.getByRole("radio", { name: "White" }), { key: "End" });
    const custom = screen.getByRole("radio", { name: "Custom" });
    expect(custom).toHaveAttribute("aria-checked", "true");
    expect(custom).toHaveFocus();

    fireEvent.keyDown(custom, { key: "Home" });
    const studio = screen.getByRole("radio", { name: "Studio" });
    expect(studio).toHaveAttribute("aria-checked", "true");
    expect(studio).toHaveFocus();
  });

  it("keeps only the selected swatch in the tab order (roving tabindex)", () => {
    render(<Harness initialPreset="white" />);

    const radios = screen.getAllByRole("radio");
    const tabbable = radios.filter((radio) => radio.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAccessibleName("White");
    for (const radio of radios) {
      if (radio !== tabbable[0]) expect(radio).toHaveAttribute("tabindex", "-1");
    }
  });

  it("clicking the White swatch calls onPresetChange('white')", () => {
    const onPresetChange = vi.fn();
    render(<Harness onPresetChange={onPresetChange} />);

    fireEvent.click(screen.getByRole("radio", { name: "White" }));

    expect(onPresetChange).toHaveBeenCalledWith("white");
  });

  it("changing the custom color input fires onCustomChange and selects custom", () => {
    const onPresetChange = vi.fn();
    const onCustomChange = vi.fn();
    render(<Harness onPresetChange={onPresetChange} onCustomChange={onCustomChange} />);

    fireEvent.change(customColorInput(), { target: { value: "#123456" } });

    expect(onCustomChange).toHaveBeenCalledWith("#123456");
    expect(onPresetChange).toHaveBeenCalledWith("custom");
    expect(screen.getByRole("radio", { name: "Custom" })).toHaveAttribute("aria-checked", "true");
  });
});
