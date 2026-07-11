import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { InlineEdit } from "@/components/InlineEdit";

describe("InlineEdit", () => {
  it("renders the value with an Edit pencil affordance at rest, no textbox", () => {
    render(<InlineEdit value="Articulated Dragon" aria-label="name" onSave={vi.fn()} />);

    expect(screen.getByText("Articulated Dragon")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit name" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("opens the editor (input + Save/Cancel) when the pencil is clicked", () => {
    render(<InlineEdit value="Articulated Dragon" aria-label="name" onSave={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));

    expect(screen.getByRole("textbox", { name: "name" })).toHaveValue("Articulated Dragon");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("does NOT save on blur -- the editor stays open with the draft intact", () => {
    const onSave = vi.fn();
    render(<InlineEdit value="Articulated Dragon" aria-label="name" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));

    const input = screen.getByRole("textbox", { name: "name" });
    fireEvent.change(input, { target: { value: "New Name" } });
    fireEvent.blur(input);

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "name" })).toHaveValue("New Name");
  });

  it("Save commits the trimmed draft and closes the editor", () => {
    const onSave = vi.fn();
    render(<InlineEdit value="Articulated Dragon" aria-label="name" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));

    fireEvent.change(screen.getByRole("textbox", { name: "name" }), {
      target: { value: "  New Name  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledExactlyOnceWith("New Name");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("Save no-ops when the trimmed draft is unchanged", () => {
    const onSave = vi.fn();
    render(<InlineEdit value="Articulated Dragon" aria-label="name" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("Cancel reverts the draft and closes the editor without saving", () => {
    const onSave = vi.fn();
    render(<InlineEdit value="Articulated Dragon" aria-label="name" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));

    fireEvent.change(screen.getByRole("textbox", { name: "name" }), { target: { value: "Discarded" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    // Re-opening shows the original value, not the discarded draft.
    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));
    expect(screen.getByRole("textbox", { name: "name" })).toHaveValue("Articulated Dragon");
  });

  it("Escape reverts and closes the editor without saving", () => {
    const onSave = vi.fn();
    render(<InlineEdit value="Articulated Dragon" aria-label="name" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));

    fireEvent.change(screen.getByRole("textbox", { name: "name" }), { target: { value: "Discarded" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "name" }), { key: "Escape" });

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("Enter commits a single-line field", () => {
    const onSave = vi.fn();
    render(<InlineEdit value="Articulated Dragon" aria-label="name" onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit name" }));

    const input = screen.getByRole("textbox", { name: "name" });
    fireEvent.change(input, { target: { value: "New Name" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSave).toHaveBeenCalledExactlyOnceWith("New Name");
  });

  it("plain Enter does NOT commit a multiline field", () => {
    const onSave = vi.fn();
    render(<InlineEdit value="A flexible dragon" aria-label="description" multiline onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));

    const textarea = screen.getByRole("textbox", { name: "description" });
    fireEvent.change(textarea, { target: { value: "A flexible dragon\nmore" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "description" })).toBeInTheDocument();
  });

  it("Cmd/Ctrl+Enter commits a multiline field", () => {
    const onSave = vi.fn();
    render(<InlineEdit value="A flexible dragon" aria-label="description" multiline onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit description" }));

    const textarea = screen.getByRole("textbox", { name: "description" });
    fireEvent.change(textarea, { target: { value: "Updated description" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    expect(onSave).toHaveBeenCalledExactlyOnceWith("Updated description");
  });

  it("shows the placeholder when the value is empty", () => {
    render(<InlineEdit value="" placeholder="Add a description…" aria-label="description" onSave={vi.fn()} />);

    expect(screen.getByText("Add a description…")).toBeInTheDocument();
  });
});
