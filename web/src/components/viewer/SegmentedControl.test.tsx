import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";

import { SegmentedControl } from "@/components/viewer/SegmentedControl";

type Fruit = "apple" | "banana" | "cherry";
const OPTIONS: readonly Fruit[] = ["apple", "banana", "cherry"];
const LABELS: Record<Fruit, string> = { apple: "Apple", banana: "Banana", cherry: "Cherry" };

// `SegmentedControl` is controlled -- exercising the roving-tabindex/arrow-key
// contract needs a real re-render when `onChange` fires (focus has to land on
// the newly-selected button), not just a spy -- so drive it through a small
// stateful harness, the same way `ViewerTab` drives the control it was
// extracted from.
function Harness({ initial = "apple", onChange }: { initial?: Fruit; onChange?: (next: Fruit) => void }) {
  const [value, setValue] = useState<Fruit>(initial);
  return (
    <SegmentedControl
      label="Fruit"
      options={OPTIONS}
      labels={LABELS}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe("SegmentedControl", () => {
  it("renders a labelled radiogroup of radio segments, one checked", () => {
    render(<Harness />);

    expect(screen.getByRole("radiogroup", { name: "Fruit" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "Apple" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Banana" })).toHaveAttribute("aria-checked", "false");
  });

  it("clicking a segment calls onChange with that option", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.click(screen.getByRole("radio", { name: "Banana" }));

    expect(onChange).toHaveBeenCalledWith("banana");
  });

  it("ArrowRight moves focus and selection to the next option", () => {
    render(<Harness />);

    fireEvent.keyDown(screen.getByRole("radio", { name: "Apple" }), { key: "ArrowRight" });

    const banana = screen.getByRole("radio", { name: "Banana" });
    expect(banana).toHaveAttribute("aria-checked", "true");
    expect(banana).toHaveFocus();
  });

  it("ArrowRight from the last option wraps to the first", () => {
    render(<Harness initial="cherry" />);

    fireEvent.keyDown(screen.getByRole("radio", { name: "Cherry" }), { key: "ArrowRight" });

    const apple = screen.getByRole("radio", { name: "Apple" });
    expect(apple).toHaveAttribute("aria-checked", "true");
    expect(apple).toHaveFocus();
  });

  it("ArrowLeft from the first option wraps to the last", () => {
    render(<Harness />);

    fireEvent.keyDown(screen.getByRole("radio", { name: "Apple" }), { key: "ArrowLeft" });

    const cherry = screen.getByRole("radio", { name: "Cherry" });
    expect(cherry).toHaveAttribute("aria-checked", "true");
    expect(cherry).toHaveFocus();
  });

  it("ArrowDown/ArrowUp behave the same as ArrowRight/ArrowLeft", () => {
    render(<Harness initial="banana" />);

    fireEvent.keyDown(screen.getByRole("radio", { name: "Banana" }), { key: "ArrowDown" });
    expect(screen.getByRole("radio", { name: "Cherry" })).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(screen.getByRole("radio", { name: "Cherry" }), { key: "ArrowUp" });
    expect(screen.getByRole("radio", { name: "Banana" })).toHaveAttribute("aria-checked", "true");
  });

  it("Home and End jump to the first and last option", () => {
    render(<Harness initial="banana" />);

    fireEvent.keyDown(screen.getByRole("radio", { name: "Banana" }), { key: "End" });
    const cherry = screen.getByRole("radio", { name: "Cherry" });
    expect(cherry).toHaveAttribute("aria-checked", "true");
    expect(cherry).toHaveFocus();

    fireEvent.keyDown(cherry, { key: "Home" });
    const apple = screen.getByRole("radio", { name: "Apple" });
    expect(apple).toHaveAttribute("aria-checked", "true");
    expect(apple).toHaveFocus();
  });

  it("keeps only the selected segment in the tab order (roving tabindex)", () => {
    render(<Harness initial="banana" />);

    const radios = screen.getAllByRole("radio");
    const tabbable = radios.filter((radio) => radio.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAccessibleName("Banana");
    for (const radio of radios) {
      if (radio !== tabbable[0]) expect(radio).toHaveAttribute("tabindex", "-1");
    }
  });
});
