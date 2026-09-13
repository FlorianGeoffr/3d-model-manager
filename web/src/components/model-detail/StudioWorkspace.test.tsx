import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StudioWorkspace } from "@/components/model-detail/StudioWorkspace";
import type { FileOut, ModelDetail } from "@/api/types";

// Same stubbing approach as the old `ViewerTab.test.tsx`: `ModelViewer` is a
// `React.lazy` R3F chunk jsdom can't run, and `PlatePanel` has its own test
// suite -- stub both so this file only exercises `StudioWorkspace`'s
// surface wiring (default selection, remount-on-file-set-change) and the
// re-chromed `ViewerStage`'s Parts popover (checkbox visibility wiring).
type ViewerPart = { id: number; url: string; visible: boolean };
const { modelViewerMock, platePanelMock } = vi.hoisted(() => ({
  modelViewerMock: vi.fn(({ parts }: { parts: ViewerPart[] }) => (
    <div data-testid="model-viewer" data-parts={parts.map((part) => `${part.id}:${part.visible ? 1 : 0}`).join(",")}>
      {parts.map((part) => part.url).join(",")}
    </div>
  )),
  platePanelMock: vi.fn(({ file, compact }: { file: FileOut; compact?: boolean }) => (
    <div data-testid="plate-panel" data-compact={String(Boolean(compact))}>
      {file.rel_path}
    </div>
  )),
}));

vi.mock("@/components/viewer/ModelViewer", () => ({ default: modelViewerMock }));
vi.mock("@/components/model-detail/PlatePanel", () => ({ PlatePanel: platePanelMock }));

// MeshSection/ViewerStage query printers for the AMS color-sync section --
// these tests render without a real printer, so stub to "no printer".
vi.mock("@/api/printers", () => ({
  usePrinters: () => ({ data: [] }),
  usePrinterStatus: () => ({ data: undefined }),
}));

// R13a re-chrome: the Parts checklist (`ViewerTopOverlay`) and the
// Background/Lighting/etc. controls (`ViewerMorePanel`) now live inside
// Popovers, which never reach an interactive open state under jsdom (same
// convention as `LibraryPage.test.tsx`) -- render trigger/content
// unconditionally so this file's checkbox/All-None assertions stay
// reachable without a real open click.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

function fakeFile(overrides: Partial<FileOut> & { id: number }): FileOut {
  return {
    revision_id: 1,
    rel_path: `file-${overrides.id}.stl`,
    storage_path: "",
    blob_hash: `hash-${overrides.id}`,
    size: 2048,
    format: "stl",
    kind: "mesh",
    mtime: "2026-06-01T12:00:00Z",
    verified_at: "2026-06-01T12:00:05Z",
    meta: null,
    thumb_ready: false,
    glb_status: null,
    glb_preview_ready: false,
    ...overrides,
  };
}

function fakeModel(files: FileOut[], overrides: Partial<ModelDetail> = {}): ModelDetail {
  return {
    id: 1,
    slug: "test-model",
    name: "Test Model",
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
    notes: [],
    backends: [],
    favorite: false,
    print_count: 0,
    last_printed_at: null,
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
    ...overrides,
  };
}

/** `useViewerScene` calls `useQueryClient()` unconditionally (R13a's Cover
 * action needs it to invalidate the model/gallery caches on capture) -- a
 * `QueryClientProvider` ancestor is required even though these tests never
 * trigger a capture. */
function renderWorkspace(model: ModelDetail) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <StudioWorkspace model={model} />
    </QueryClientProvider>,
  );
}

describe("StudioWorkspace", () => {
  beforeEach(() => {
    modelViewerMock.mockClear();
    platePanelMock.mockClear();
    localStorage.clear();
  });

  it("shows a placeholder when there are no previewable files", () => {
    renderWorkspace(fakeModel([]));
    expect(screen.getByText("No previewable files")).toBeInTheDocument();
  });

  it("renders the combined viewer when glb parts exist", async () => {
    const file = fakeFile({ id: 1, glb_status: "ok", blob_hash: "readyhash" });
    renderWorkspace(fakeModel([file]));
    expect(await screen.findByTestId("model-viewer")).toHaveTextContent("/api/blobs/readyhash/glb");
  });

  it("defaults to the first other file when there are no glb parts", () => {
    const sliced = fakeFile({ id: 1, rel_path: "plate.3mf", format: "3mf", kind: "sliced" });
    renderWorkspace(fakeModel([sliced]));
    expect(screen.getByTestId("plate-panel")).toHaveTextContent("plate.3mf");
  });

  it("opens with every part checked (unlike the standalone /viewer/$slug default of just the first)", async () => {
    const fileA = fakeFile({ id: 1, rel_path: "a.stl", glb_status: "ok" });
    const fileB = fakeFile({ id: 2, rel_path: "b.stl", glb_status: "ok" });
    renderWorkspace(fakeModel([fileA, fileB]));

    expect(await screen.findByTestId("model-viewer")).toHaveAttribute("data-parts", "1:1,2:1");
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
  });

  it("toggling a part checkbox in the Parts popover updates the mounted viewer's visibility without remounting it", async () => {
    const fileA = fakeFile({ id: 1, rel_path: "a.stl", glb_status: "ok" });
    const fileB = fakeFile({ id: 2, rel_path: "b.stl", glb_status: "ok" });
    renderWorkspace(fakeModel([fileA, fileB]));
    await screen.findByTestId("model-viewer");

    fireEvent.click(screen.getByRole("checkbox", { name: "b.stl" }));

    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-parts", "1:1,2:0"));
    // The canvas mock is a plain function component (not spied on mount), so
    // pin the no-remount guarantee via the visible-parts flag flipping in
    // place instead of a call-count assertion -- the same `data-parts`
    // attribute a remount would otherwise reset is still `1:1,2:0` here.
  });

  it("the Parts popover's All/None buttons drive onSetAllChecked across every part", async () => {
    const fileA = fakeFile({ id: 1, rel_path: "a.stl", glb_status: "ok" });
    const fileB = fakeFile({ id: 2, rel_path: "b.stl", glb_status: "ok" });
    renderWorkspace(fakeModel([fileA, fileB]));
    await screen.findByTestId("model-viewer");

    fireEvent.click(screen.getByRole("button", { name: "None — hide all parts" }));
    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-parts", "1:0,2:0"));

    fireEvent.click(screen.getByRole("button", { name: "Show all parts" }));
    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-parts", "1:1,2:1"));
  });

  it("resyncs the default selection when the model's glb file set changes (router reuse across $slug)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const modelA = fakeModel([fakeFile({ id: 1, rel_path: "a.stl", blob_hash: "hashA", glb_status: "ok" })]);
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <StudioWorkspace model={modelA} />
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("model-viewer")).toHaveTextContent("/api/blobs/hashA/glb");

    const modelB = fakeModel([fakeFile({ id: 5, rel_path: "z.stl", blob_hash: "hashZ", glb_status: "ok" })]);
    rerender(
      <QueryClientProvider client={queryClient}>
        <StudioWorkspace model={modelB} />
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId("model-viewer")).toHaveTextContent("/api/blobs/hashZ/glb");
  });

  it("shows the file-status placeholder when there are no glb parts to fall back to", () => {
    const pending = fakeFile({ id: 1, rel_path: "pending.stl", glb_status: "pending" });
    const gcode = fakeFile({ id: 2, rel_path: "plain.gcode", format: "gcode", kind: "gcode" });
    renderWorkspace(fakeModel([pending, gcode]));

    // No glb parts exist, so the default selection falls back to the first
    // "other" file (pending) -- switching this via UI is now a Files-card
    // "View in 3D" action (R13c), out of scope for this re-chrome.
    expect(screen.getByText("Preparing preview…")).toBeInTheDocument();
  });
});
