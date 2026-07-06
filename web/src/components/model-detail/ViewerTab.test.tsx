import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { ViewerTab } from "@/components/model-detail/ViewerTab";
import type { FileOut, ModelDetail } from "@/api/types";

// `ModelViewer` is a `React.lazy` chunk that mounts an R3F `<Canvas>`, which
// jsdom can't run (no WebGL) -- stub it so ViewerTab's branching logic can
// be exercised without ever touching three.js.
const { modelViewerMock, platePanelMock } = vi.hoisted(() => ({
  modelViewerMock: vi.fn(({ url }: { url: string }) => <div data-testid="model-viewer">{url}</div>),
  // `PlatePanel` has its own dedicated test suite (PlatePanel.test.tsx) --
  // stub it here so this file only asserts that ViewerTab wires it in for
  // sliced files, not its internals.
  platePanelMock: vi.fn(({ file }: { file: FileOut }) => <div data-testid="plate-panel">{file.rel_path}</div>),
}));

vi.mock("@/components/viewer/ModelViewer", () => ({ default: modelViewerMock }));
vi.mock("@/components/model-detail/PlatePanel", () => ({ PlatePanel: platePanelMock }));

// Radix's Select never reaches an interactive open state under jsdom (same
// floating-ui/dismissable-layer limitation as Popover -- see the inline
// mock in UploadPage.test.tsx) -- swap it for a native <select> so the
// picker-switching test can drive it with a plain change event.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange: (value: string) => void;
    children?: ReactNode;
  }) => (
    <select aria-label="File" value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => <option value={value}>{children}</option>,
}));

function fakeFile(overrides: Partial<FileOut> = {}): FileOut {
  return {
    id: 1,
    revision_id: 1,
    rel_path: "model.stl",
    storage_path: "/data/model.stl",
    blob_hash: "hash1",
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

function fakeModel(files: FileOut[]): ModelDetail {
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

describe("ViewerTab", () => {
  beforeEach(() => {
    modelViewerMock.mockClear();
    platePanelMock.mockClear();
  });

  it("shows a placeholder when there are no previewable files", () => {
    render(<ViewerTab model={fakeModel([])} />);
    expect(screen.getByText("No previewable files")).toBeInTheDocument();
  });

  it("lazily renders the 3D viewer for a ready GLB, passing the blob's glb URL", async () => {
    const file = fakeFile({ glb_status: "ok", blob_hash: "readyhash" });
    render(<ViewerTab model={fakeModel([file])} />);

    expect(await screen.findByTestId("model-viewer")).toHaveTextContent("/api/blobs/readyhash/glb");
  });

  it("shows a preparing-preview card while the GLB conversion job is pending", () => {
    const file = fakeFile({ glb_status: "pending" });
    render(<ViewerTab model={fakeModel([file])} />);
    expect(screen.getByText("Preparing preview…")).toBeInTheDocument();
  });

  it("shows a destructive failed card when GLB conversion failed", () => {
    const file = fakeFile({ glb_status: "failed" });
    render(<ViewerTab model={fakeModel([file])} />);
    expect(screen.getByText("Preview failed")).toBeInTheDocument();
  });

  it("shows a muted unsupported-format card", () => {
    const file = fakeFile({ glb_status: "unsupported" });
    render(<ViewerTab model={fakeModel([file])} />);
    expect(screen.getByText("No 3D preview")).toBeInTheDocument();
  });

  it("renders the plate panel for a sliced file", () => {
    const file = fakeFile({ format: "gcode_3mf", kind: "sliced", glb_status: null });
    render(<ViewerTab model={fakeModel([file])} />);
    expect(screen.getByTestId("plate-panel")).toHaveTextContent(file.rel_path);
  });

  it("shows the no-preview placeholder for plain gcode", () => {
    const file = fakeFile({ format: "gcode", kind: "gcode", glb_status: null, rel_path: "print.gcode" });
    render(<ViewerTab model={fakeModel([file])} />);
    expect(screen.getByText("Plain G-code — no 3D preview")).toBeInTheDocument();
  });

  it("swaps the rendered preview's URL when a different file is picked", async () => {
    const fileA = fakeFile({ id: 1, rel_path: "a.stl", blob_hash: "hashA", glb_status: "ok" });
    const fileB = fakeFile({ id: 2, rel_path: "b.stl", blob_hash: "hashB", glb_status: "ok" });
    const { container } = render(<ViewerTab model={fakeModel([fileA, fileB])} />);

    expect(await screen.findByTestId("model-viewer")).toHaveTextContent("/api/blobs/hashA/glb");

    const select = container.querySelector("select");
    if (!select) throw new Error("file select not found");
    fireEvent.change(select, { target: { value: String(fileB.id) } });

    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveTextContent("/api/blobs/hashB/glb"));
  });
});
