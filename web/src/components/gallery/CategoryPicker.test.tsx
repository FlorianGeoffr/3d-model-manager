import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { CategoryPicker } from "@/components/gallery/CategoryPicker";

const { categoriesBox } = vi.hoisted(() => ({
  categoriesBox: {
    current: [
      { id: 1, name: "Miniatures", color: "red", model_count: 3 },
      { id: 2, name: "Vases", color: "green", model_count: 1 },
    ],
  },
}));

vi.mock("@/api/categories", () => ({
  useCategories: () => ({ data: categoriesBox.current }),
}));

// Radix's Select never reaches an interactive open state under jsdom -- swap
// it for a plain native <select> so options are drivable via change events
// (same pattern as SettingsPage.test.tsx's backend-type picker).
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value?: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
    children?: ReactNode;
  }) => (
    <select
      aria-label="Category"
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

describe("CategoryPicker", () => {
  it("lists every category plus a None option", () => {
    render(<CategoryPicker value={null} onChange={vi.fn()} />);

    const select = screen.getByLabelText("Category");
    expect(screen.getByText("None")).toBeInTheDocument();
    expect(screen.getByText("Miniatures")).toBeInTheDocument();
    expect(screen.getByText("Vases")).toBeInTheDocument();
    expect(select).toHaveValue("__none__");
  });

  it("reflects the selected category's id as the value", () => {
    render(<CategoryPicker value={2} onChange={vi.fn()} />);

    expect(screen.getByLabelText("Category")).toHaveValue("2");
  });

  it("calls onChange with the numeric id when a category is picked", () => {
    const onChange = vi.fn();
    render(<CategoryPicker value={null} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "1" } });

    expect(onChange).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("calls onChange with null when None is picked", () => {
    const onChange = vi.fn();
    render(<CategoryPicker value={2} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Category"), { target: { value: "__none__" } });

    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });
});
