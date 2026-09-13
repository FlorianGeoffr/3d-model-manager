import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MetadataEditor } from "@/components/model-detail/MetadataEditor";
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

function renderEditor(model: ModelDetail) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MetadataEditor model={model} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  patchMock.mockClear();
});

describe("MetadataEditor", () => {
  it("renders existing metadata entries", () => {
    renderEditor(baseModel({ metadata: { Scale: "1:8", Material: "PLA" } }));

    expect(screen.getByDisplayValue("Scale")).toBeInTheDocument();
    expect(screen.getByDisplayValue("1:8")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Material")).toBeInTheDocument();
    expect(screen.getByDisplayValue("PLA")).toBeInTheDocument();
  });

  it("shows the empty state and no rows when there is no metadata", () => {
    renderEditor(baseModel());

    expect(screen.getByText("No custom fields yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add field" })).toBeInTheDocument();
  });

  it("patches the merged object when a value is edited and blurred", async () => {
    renderEditor(baseModel({ metadata: { Scale: "1:8" } }));

    const valueInput = screen.getByDisplayValue("1:8");
    fireEvent.change(valueInput, { target: { value: "1:6" } });
    fireEvent.blur(valueInput);

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith("/models/articulated-dragon", { metadata: { Scale: "1:6" } }),
    );
  });

  it("adding a row and filling key/value then blurring patches the merged object", async () => {
    renderEditor(baseModel({ metadata: { Scale: "1:8" } }));

    fireEvent.click(screen.getByRole("button", { name: "Add field" }));
    const keyInputs = screen.getAllByPlaceholderText("Field name");
    const newKeyInput = keyInputs[keyInputs.length - 1];
    fireEvent.change(newKeyInput, { target: { value: "Weight" } });
    fireEvent.blur(newKeyInput);

    await waitFor(() =>
      expect(patchMock).toHaveBeenLastCalledWith("/models/articulated-dragon", {
        metadata: { Scale: "1:8", Weight: "" },
      }),
    );

    const valueInputs = screen.getAllByPlaceholderText("Value");
    const newValueInput = valueInputs[valueInputs.length - 1];
    fireEvent.change(newValueInput, { target: { value: "250g" } });
    fireEvent.blur(newValueInput);

    await waitFor(() =>
      expect(patchMock).toHaveBeenLastCalledWith("/models/articulated-dragon", {
        metadata: { Scale: "1:8", Weight: "250g" },
      }),
    );
  });

  it("deleting a row patches immediately with the row removed", async () => {
    renderEditor(baseModel({ metadata: { Scale: "1:8", Material: "PLA" } }));

    fireEvent.click(screen.getByRole("button", { name: "Remove Scale" }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith("/models/articulated-dragon", { metadata: { Material: "PLA" } }),
    );
  });

  it("disables Add field at the 50-row cap", () => {
    const metadata: Record<string, string> = {};
    for (let i = 0; i < 50; i++) metadata[`field-${i}`] = String(i);
    renderEditor(baseModel({ metadata }));

    expect(screen.getByRole("button", { name: "Add field" })).toBeDisabled();
    expect(screen.getByText("Up to 50 custom fields.")).toBeInTheDocument();
  });
});
