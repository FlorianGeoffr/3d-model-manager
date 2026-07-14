import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ExpandCollapseAll } from "@/components/ExpandCollapseAll";

type Props = {
  allOpen: boolean;
  allClosed: boolean;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  label: string;
};

function renderControl(overrides: Partial<Props> = {}) {
  const onExpandAll = vi.fn();
  const onCollapseAll = vi.fn();
  render(
    <ExpandCollapseAll
      allOpen={false}
      allClosed={false}
      onExpandAll={onExpandAll}
      onCollapseAll={onCollapseAll}
      label="review groups"
      {...overrides}
    />,
  );
  return { onExpandAll, onCollapseAll };
}

describe("ExpandCollapseAll", () => {
  it("renders both buttons with aria-labels containing the label prop", () => {
    renderControl();

    expect(screen.getByRole("button", { name: "Expand all review groups" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse all review groups" })).toBeInTheDocument();
  });

  it("neither button is disabled when neither allOpen nor allClosed", () => {
    renderControl({ allOpen: false, allClosed: false });

    expect(screen.getByRole("button", { name: "Expand all review groups" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Collapse all review groups" })).toBeEnabled();
  });

  it("disables the expand button when allOpen", () => {
    renderControl({ allOpen: true, allClosed: false });

    expect(screen.getByRole("button", { name: "Expand all review groups" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Collapse all review groups" })).toBeEnabled();
  });

  it("disables the collapse button when allClosed", () => {
    renderControl({ allOpen: false, allClosed: true });

    expect(screen.getByRole("button", { name: "Expand all review groups" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Collapse all review groups" })).toBeDisabled();
  });

  it("clicking the expand button fires onExpandAll only", () => {
    const { onExpandAll, onCollapseAll } = renderControl();

    fireEvent.click(screen.getByRole("button", { name: "Expand all review groups" }));

    expect(onExpandAll).toHaveBeenCalledTimes(1);
    expect(onCollapseAll).not.toHaveBeenCalled();
  });

  it("clicking the collapse button fires onCollapseAll only", () => {
    const { onExpandAll, onCollapseAll } = renderControl();

    fireEvent.click(screen.getByRole("button", { name: "Collapse all review groups" }));

    expect(onCollapseAll).toHaveBeenCalledTimes(1);
    expect(onExpandAll).not.toHaveBeenCalled();
  });

  it("clicking a disabled expand button fires nothing", () => {
    const { onExpandAll } = renderControl({ allOpen: true });

    fireEvent.click(screen.getByRole("button", { name: "Expand all review groups" }));

    expect(onExpandAll).not.toHaveBeenCalled();
  });

  it("clicking a disabled collapse button fires nothing", () => {
    const { onCollapseAll } = renderControl({ allClosed: true });

    fireEvent.click(screen.getByRole("button", { name: "Collapse all review groups" }));

    expect(onCollapseAll).not.toHaveBeenCalled();
  });
});
