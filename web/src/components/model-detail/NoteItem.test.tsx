import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { NoteItem } from "@/components/model-detail/NoteItem";
import type { NoteOut } from "@/api/types";

const NOTE: NoteOut = {
  id: 1,
  model_id: 1,
  revision_id: null,
  body: "Printed at 0.2mm without issue.",
  created_at: "2026-06-01T12:00:00Z",
  updated_at: "2026-06-01T12:00:00Z",
};

function renderNote(onDelete = vi.fn(), onSave = vi.fn()) {
  return {
    onDelete,
    onSave,
    ...render(
      <ul>
        <NoteItem note={NOTE} isSaving={false} onSave={onSave} onDelete={onDelete} />
      </ul>,
    ),
  };
}

describe("NoteItem", () => {
  it("does not delete immediately -- clicking Delete opens a confirm dialog first", () => {
    const { onDelete } = renderNote();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onDelete).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Delete this note?")).toBeInTheDocument();
  });

  it("confirming the dialog fires onDelete", () => {
    const { onDelete } = renderNote();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("closing the dialog without confirming does not fire onDelete", () => {
    const { onDelete } = renderNote();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("dialog");
    // The dialog has two equivalent "Close" affordances (header X icon,
    // footer button) -- either one dismisses without confirming.
    const [closeButton] = within(dialog).getAllByRole("button", { name: "Close" });
    fireEvent.click(closeButton);

    expect(onDelete).not.toHaveBeenCalled();
  });

  it("still enters the inline edit form via Edit, unaffected by the delete gate", () => {
    renderNote();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByDisplayValue(NOTE.body)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });
});
