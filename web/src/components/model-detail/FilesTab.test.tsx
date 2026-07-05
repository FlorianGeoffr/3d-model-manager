import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FilesTab } from "@/components/model-detail/FilesTab";
import type { FileOut, ModelDetail } from "@/api/types";

const VERIFIED_FILE: FileOut = {
  id: 1,
  revision_id: 1,
  rel_path: "model.stl",
  storage_path: "/data/model.stl",
  blob_hash: "abc123def456",
  size: 2048,
  format: "stl",
  kind: "mesh",
  mtime: "2026-06-01T12:00:00Z",
  verified_at: "2026-06-01T12:00:05Z",
};

const PROCESSING_FILE: FileOut = {
  ...VERIFIED_FILE,
  id: 2,
  rel_path: "still-processing.stl",
  verified_at: null,
};

function buildModel(files: FileOut[]): ModelDetail {
  return {
    id: 1,
    slug: "test-model",
    name: "Test Model",
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
    tags: [],
    notes: [],
    current_revision: {
      id: 1,
      model_id: 1,
      number: 1,
      name: null,
      note: null,
      dir_name: "r1",
      created_at: "2026-06-01T12:00:00Z",
      files,
      notes: [],
    },
  };
}

function renderFilesTab(files: FileOut[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <FilesTab model={buildModel(files)} />
    </QueryClientProvider>,
  );
}

describe("FilesTab", () => {
  it("keeps the download action enabled and linked for a verified file", () => {
    renderFilesTab([VERIFIED_FILE]);

    const downloadLink = screen.getByRole("link", { name: `Download ${VERIFIED_FILE.rel_path}` });
    expect(downloadLink).toHaveAttribute("href", `/api/files/${VERIFIED_FILE.id}/download`);
  });

  it("disables the download action for a file still processing (verified_at === null)", () => {
    renderFilesTab([PROCESSING_FILE]);

    // Not rendered as a navigable link at all — no raw-409 SPA navigation.
    expect(screen.queryByRole("link", { name: `Download ${PROCESSING_FILE.rel_path}` })).not.toBeInTheDocument();

    const downloadButton = screen.getByRole("button", { name: `Download ${PROCESSING_FILE.rel_path}` });
    expect(downloadButton).toBeDisabled();
    expect(downloadButton).toHaveAttribute("title", expect.stringMatching(/processing/i));

    expect(screen.getByText("processing")).toBeInTheDocument();
  });
});
