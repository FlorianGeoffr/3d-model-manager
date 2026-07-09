import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SpecRow } from "@/components/ui/spec-row";

describe("SpecRow", () => {
  it("renders only present items, dot-separated", () => {
    const { container } = render(
      <SpecRow
        items={[{ label: "2h10m" }, null, { label: "PLA" }, undefined, { label: "84mm" }]}
      />,
    );
    expect(screen.getByText("2h10m")).toBeInTheDocument();
    expect(screen.getByText("PLA")).toBeInTheDocument();
    expect(screen.getByText("84mm")).toBeInTheDocument();
    // three present items -> two middot separators
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
  });

  it("renders nothing when there are no present items", () => {
    const { container } = render(<SpecRow items={[null, undefined, { label: "" }]} />);
    expect(container.firstChild).toBeNull();
  });
});
