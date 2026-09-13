import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PrintTipsCard } from "@/components/model-detail/cards/PrintTipsCard";
import type { ModelDetail } from "@/api/types";

const { patchMock } = vi.hoisted(() => ({
  patchMock: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, patch: patchMock },
  };
});

function baseModel(overrides: Partial<ModelDetail> = {}): ModelDetail {
  return {
    id: 1,
    slug: "articulated-dragon",
    name: "Articulated Dragon",
    description: null,
    source_url: null,
    source_site: null,
    source_author: null,
    source_license: null,
    source_collection_id: null,
    source_collection_title: null,
    imported_at: null,
    cover_blob_hash: null,
    is_archived: false,
    created_at: "2026-06-01T12:00:00Z",
    updated_at: "2026-06-01T12:00:00Z",
    tags: [],
    current_revision: null,
    notes: [],
    backends: [],
    favorite: false,
    print_count: 0,
    last_printed_at: null,
    metadata: null,
    print_tips: null,
    ...overrides,
  };
}

function renderCard(model: ModelDetail) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PrintTipsCard model={model} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  patchMock.mockClear();
});

describe("PrintTipsCard", () => {
  it("renders the current print tips", () => {
    renderCard(baseModel({ print_tips: "Use a raft for the tail." }));

    expect(screen.getByText("Use a raft for the tail.")).toBeInTheDocument();
  });

  it("shows the placeholder when there are no tips yet", () => {
    renderCard(baseModel());

    expect(screen.getByText(/Add print tips/)).toBeInTheDocument();
  });

  it("saves the trimmed value via patch", async () => {
    renderCard(baseModel());

    fireEvent.click(screen.getByRole("button", { name: "Edit print tips" }));
    fireEvent.change(screen.getByLabelText("print tips"), { target: { value: "  Print flat.  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith("/models/articulated-dragon", { print_tips: "Print flat." }),
    );
  });

  it("saves null when the value is cleared", async () => {
    renderCard(baseModel({ print_tips: "Existing tip" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit print tips" }));
    fireEvent.change(screen.getByLabelText("print tips"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith("/models/articulated-dragon", { print_tips: null }),
    );
  });
});
