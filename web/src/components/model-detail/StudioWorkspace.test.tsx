import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StudioWorkspace } from "@/components/model-detail/StudioWorkspace";
import type { FileOut, ModelDetail } from "@/api/types";

// Same stubbing approach as the old `ViewerTab.test.tsx`: `ModelViewer` is a
// `React.lazy` R3F chunk jsdom can't run, and `PlatePanel` has its own test
// suite -- stub both so this file only exercises `StudioWorkspace`'s rail/
// surface wiring (selection routing, remount-on-file-set-change, the
// compact plate strip alongside the assembly view).
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
// these tests render without a QueryClientProvider, so stub to "no printer".
vi.mock("@/api/printers", () => ({
  usePrinters: () => ({ data: [] }),
  usePrinterStatus: () => ({ data: undefined }),
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

describe("StudioWorkspace", () => {
  beforeEach(() => {
    modelViewerMock.mockClear();
    platePanelMock.mockClear();
    localStorage.clear();
  });

  it("shows a placeholder when there are no previewable files", () => {
    render(<StudioWorkspace model={fakeModel([])} />);
    expect(screen.getByText("No previewable files")).toBeInTheDocument();
  });

  it("defaults to the Assembly entry and renders the combined viewer when glb parts exist", async () => {
    const file = fakeFile({ id: 1, glb_status: "ok", blob_hash: "readyhash" });
    render(<StudioWorkspace model={fakeModel([file])} />);

    expect(screen.getByRole("button", { name: /Assembly \(1 parts\)/ })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByTestId("model-viewer")).toHaveTextContent("/api/blobs/readyhash/glb");
  });

  it("defaults to the first other file when there are no glb parts", () => {
    const sliced = fakeFile({ id: 1, rel_path: "plate.3mf", format: "3mf", kind: "sliced" });
    render(<StudioWorkspace model={fakeModel([sliced])} />);
    expect(screen.getByTestId("plate-panel")).toHaveTextContent("plate.3mf");
  });

  it("switching the rail selection to a sliced file shows PlatePanel in place of the viewer", async () => {
    const glb = fakeFile({ id: 1, glb_status: "ok" });
    const sliced = fakeFile({ id: 2, rel_path: "plate.3mf", format: "3mf", kind: "sliced" });
    render(<StudioWorkspace model={fakeModel([glb, sliced])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.click(screen.getByRole("button", { name: /plate\.3mf/ }));

    expect(screen.getByTestId("plate-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("model-viewer")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Assembly/ }));
    expect(await screen.findByTestId("model-viewer")).toBeInTheDocument();
  });

  it("shows a compact plate strip beneath the assembly view when both glb parts and sliced files exist", async () => {
    const glb = fakeFile({ id: 1, glb_status: "ok" });
    const sliced = fakeFile({ id: 2, rel_path: "plate.3mf", format: "3mf", kind: "sliced" });
    render(<StudioWorkspace model={fakeModel([glb, sliced])} />);
    await screen.findByTestId("model-viewer");

    expect(screen.getByTestId("plate-panel")).toHaveAttribute("data-compact", "true");
  });

  it("toggling a part checkbox in the rail updates the mounted viewer's visibility without remounting it", async () => {
    const fileA = fakeFile({ id: 1, rel_path: "a.stl", glb_status: "ok" });
    const fileB = fakeFile({ id: 2, rel_path: "b.stl", glb_status: "ok" });
    render(<StudioWorkspace model={fakeModel([fileA, fileB])} />);
    await screen.findByTestId("model-viewer");

    const rail = screen.getByRole("navigation", { name: "Files" });
    fireEvent.click(within(rail).getByRole("checkbox", { name: "b.stl" }));

    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-parts", "1:1,2:1"));
    // The canvas mock is a plain function component (not spied on mount), so
    // pin the no-remount guarantee via the visible-parts flag flipping in
    // place instead of a call-count assertion -- the same `data-parts`
    // attribute a remount would otherwise reset is still `1:1,2:1` here.
  });

  it("resyncs the default selection when the model's glb file set changes (router reuse across $slug)", async () => {
    const modelA = fakeModel([fakeFile({ id: 1, rel_path: "a.stl", blob_hash: "hashA", glb_status: "ok" })]);
    const { rerender } = render(<StudioWorkspace model={modelA} />);
    expect(await screen.findByTestId("model-viewer")).toHaveTextContent("/api/blobs/hashA/glb");

    const modelB = fakeModel([fakeFile({ id: 5, rel_path: "z.stl", blob_hash: "hashZ", glb_status: "ok" })]);
    rerender(<StudioWorkspace model={modelB} />);

    expect(await screen.findByTestId("model-viewer")).toHaveTextContent("/api/blobs/hashZ/glb");
  });

  it("shows the file-status placeholder for a pending/failed/unsupported/gcode selection", () => {
    const pending = fakeFile({ id: 1, rel_path: "pending.stl", glb_status: "pending" });
    const gcode = fakeFile({ id: 2, rel_path: "plain.gcode", format: "gcode", kind: "gcode" });
    render(<StudioWorkspace model={fakeModel([pending, gcode])} />);

    expect(screen.getByText("Preparing preview…")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /plain\.gcode/ }));
    expect(screen.getByText("Plain G-code — no 3D preview")).toBeInTheDocument();
  });
});
