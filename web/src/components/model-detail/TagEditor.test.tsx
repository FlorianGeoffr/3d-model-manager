import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TagEditor } from "@/components/model-detail/TagEditor";
import type { ModelDetail } from "@/api/types";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn().mockResolvedValue([]) }));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, get: getMock },
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
  imported_at: null,
  cover_blob_hash: null,
  is_archived: false,
  created_at: "2026-06-01T12:00:00Z",
  updated_at: "2026-06-01T12:00:00Z",
  tags: ["fantasy", "dragon"],
  current_revision: null,
  notes: [],
  backends: [],
};

function renderEditor(editMode: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TagEditor model={MODEL} editMode={editMode} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockClear();
});

describe("TagEditor", () => {
  it("shows tag chips without remove buttons or the add-tag control by default", () => {
    renderEditor(false);

    expect(screen.getByText("fantasy")).toBeInTheDocument();
    expect(screen.getByText("dragon")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove tag/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add tag" })).not.toBeInTheDocument();
  });

  it("shows remove buttons and the add-tag control in edit mode", () => {
    renderEditor(true);

    expect(screen.getByText("fantasy")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove tag fantasy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove tag dragon" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add tag" })).toBeInTheDocument();
  });
});
