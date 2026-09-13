import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DetailLayout } from "@/components/model-detail/DetailLayout";

describe("DetailLayout", () => {
  it("applies the elastic-left/fixed-508px-right grid classes", () => {
    const { container } = render(<DetailLayout left={<div>left</div>} right={<div>right</div>} />);

    const grid = container.firstElementChild;
    expect(grid).toHaveClass("grid", "grid-cols-1", "gap-6", "min-[900px]:grid-cols-[minmax(0,1fr)_508px]");
  });

  it("renders both the left and right slots", () => {
    render(<DetailLayout left={<div>Left content</div>} right={<div>Right content</div>} />);

    expect(screen.getByText("Left content")).toBeInTheDocument();
    expect(screen.getByText("Right content")).toBeInTheDocument();
  });
});
