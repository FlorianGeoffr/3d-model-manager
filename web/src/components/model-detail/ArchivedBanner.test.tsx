import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ArchivedBanner } from "@/components/model-detail/ArchivedBanner";
import type { ModelDetail } from "@/api/types";

const { patchMock } = vi.hoisted(() => ({ patchMock: vi.fn().mockResolvedValue({}) }));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, patch: patchMock },
  };
});

const MODEL: ModelDetail = {
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
};

function renderBanner(model: ModelDetail) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ArchivedBanner model={model} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  patchMock.mockClear();
});

describe("ArchivedBanner", () => {
  it("renders nothing for a non-archived model", () => {
    const { container } = renderBanner(MODEL);

    expect(container).toBeEmptyDOMElement();
  });

  it("shows the archived notice and an Unarchive button when is_archived", () => {
    renderBanner({ ...MODEL, is_archived: true });

    expect(screen.getByText("This model is archived.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unarchive" })).toBeInTheDocument();
  });

  it("clicking Unarchive PATCHes is_archived:false", async () => {
    renderBanner({ ...MODEL, is_archived: true });

    fireEvent.click(screen.getByRole("button", { name: "Unarchive" }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledExactlyOnceWith("/models/articulated-dragon", { is_archived: false }),
    );
  });
});
