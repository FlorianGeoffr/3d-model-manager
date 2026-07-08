import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactNode } from "react";

import { ViewerTab } from "@/components/model-detail/ViewerTab";
import type { FileOut, ModelDetail } from "@/api/types";

// `ModelViewer` is a `React.lazy` chunk that mounts an R3F `<Canvas>`, which
// jsdom can't run (no WebGL) -- stub it so ViewerTab's branching logic can
// be exercised without ever touching three.js. It now takes multiple urls
// (Workstream A "multi-part combined view") plus a resolved background
// color -- render both onto the stub so tests can assert on them.
const { modelViewerMock, platePanelMock, defaultModelViewerImpl } = vi.hoisted(() => {
  const defaultModelViewerImpl = ({ urls, background }: { urls: string[]; background: string }) => (
    <div data-testid="model-viewer" data-background={background}>
      {urls.join(",")}
    </div>
  );
  return {
    modelViewerMock: vi.fn(defaultModelViewerImpl),
    // `PlatePanel` has its own dedicated test suite (PlatePanel.test.tsx) --
    // stub it here so this file only asserts that ViewerTab wires it in for
    // sliced files, not its internals.
    platePanelMock: vi.fn(({ file }: { file: FileOut }) => <div data-testid="plate-panel">{file.rel_path}</div>),
    defaultModelViewerImpl,
  };
});

vi.mock("@/components/viewer/ModelViewer", () => ({ default: modelViewerMock }));
vi.mock("@/components/model-detail/PlatePanel", () => ({ PlatePanel: platePanelMock }));

// Radix's Select never reaches an interactive open state under jsdom (same
// floating-ui/dismissable-layer limitation as Popover -- see the inline
// mock in UploadPage.test.tsx) -- swap it for a native <select> so it can be
// driven with a plain change event. ViewerTab now renders two independent
// `<Select>`s (the non-mesh file picker and the background picker); each
// carries its accessible name via `<SelectTrigger aria-label=...>`, so this
// mock pulls that label off whichever child element declares it and puts it
// on the native `<select>` -- letting `getByRole("combobox", { name })`
// (or the old `container.querySelector("select")` for the lone-select
// tests) tell the two apart.
function ariaLabelOf(children: ReactNode): string | undefined {
  let label: string | undefined;
  Children.forEach(children, (child) => {
    if (isValidElement<{ "aria-label"?: string }>(child) && child.props && "aria-label" in child.props) {
      label = child.props["aria-label"];
    }
  });
  return label;
}

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
    <select aria-label={ariaLabelOf(children)} value={value} onChange={(event) => onValueChange(event.target.value)}>
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
    localStorage.clear();
  });

  it("shows a placeholder when there are no previewable files", () => {
    render(<ViewerTab model={fakeModel([])} />);
    expect(screen.getByText("No previewable files")).toBeInTheDocument();
  });

  it("renders the mesh viewer for a ready GLB, defaulting to that part checked", async () => {
    const file = fakeFile({ glb_status: "ok", blob_hash: "readyhash" });
    render(<ViewerTab model={fakeModel([file])} />);

    expect(await screen.findByTestId("model-viewer")).toHaveTextContent("/api/blobs/readyhash/glb");
    expect(screen.getByRole("checkbox", { name: file.rel_path })).toBeChecked();
  });

  it("checking a second glb part combines both urls into the one viewer; unchecking drops it again", async () => {
    const fileA = fakeFile({ id: 1, rel_path: "a.stl", blob_hash: "hashA", glb_status: "ok" });
    const fileB = fakeFile({ id: 2, rel_path: "b.stl", blob_hash: "hashB", glb_status: "ok" });
    render(<ViewerTab model={fakeModel([fileA, fileB])} />);

    // Only the first part is checked by default.
    expect(await screen.findByTestId("model-viewer")).toHaveTextContent("/api/blobs/hashA/glb");
    expect(screen.getByTestId("model-viewer")).not.toHaveTextContent("hashB");
    expect(screen.getByRole("checkbox", { name: "b.stl" })).not.toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", { name: "b.stl" }));
    await waitFor(() =>
      expect(screen.getByTestId("model-viewer")).toHaveTextContent("/api/blobs/hashA/glb,/api/blobs/hashB/glb"),
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "a.stl" }));
    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveTextContent("/api/blobs/hashB/glb"));
    expect(screen.getByTestId("model-viewer")).not.toHaveTextContent("hashA");
  });

  it("shows a hint instead of an empty canvas when every part is unchecked", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.click(screen.getByRole("checkbox", { name: file.rel_path }));

    expect(await screen.findByText("Select a part to preview")).toBeInTheDocument();
    expect(screen.queryByTestId("model-viewer")).not.toBeInTheDocument();
  });

  it("selecting the White background passes #ffffff to ModelViewer and persists the choice", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.change(screen.getByRole("combobox", { name: "Background" }), { target: { value: "white" } });

    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-background", "#ffffff"));
    expect(JSON.parse(localStorage.getItem("viewer-bg") ?? "{}")).toMatchObject({ preset: "white" });
  });

  it("restores a previously persisted background choice on mount", async () => {
    localStorage.setItem("viewer-bg", JSON.stringify({ preset: "dark", custom: "#a1a1aa" }));
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);

    expect(await screen.findByTestId("model-viewer")).toHaveAttribute("data-background", "#18181b");
  });

  it("lets picking a custom hex color drive the viewer background", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.change(screen.getByRole("combobox", { name: "Background" }), { target: { value: "custom" } });
    const colorInput = await screen.findByLabelText("Custom background color");
    fireEvent.change(colorInput, { target: { value: "#123456" } });

    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-background", "#123456"));
  });

  it("clicking Expand mounts a dialog containing the same combined viewer", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.click(screen.getByRole("button", { name: "Expand" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("model-viewer")).toHaveTextContent("/api/blobs/hash1/glb");
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

  it("keeps the non-mesh file picker alongside the mesh section when both kinds of file exist", async () => {
    const glb = fakeFile({ id: 1, rel_path: "a.stl", glb_status: "ok" });
    const sliced = fakeFile({ id: 2, rel_path: "b.gcode.3mf", format: "gcode_3mf", kind: "sliced", glb_status: null });
    render(<ViewerTab model={fakeModel([glb, sliced])} />);

    await screen.findByTestId("model-viewer");
    expect(screen.getByTestId("plate-panel")).toHaveTextContent("b.gcode.3mf");
    // The "sliced" file never shows up in the mesh checklist -- it has no
    // combinable GLB.
    expect(screen.queryByRole("checkbox", { name: "b.gcode.3mf" })).not.toBeInTheDocument();
  });

  it("renders a fallback card instead of crashing when the 3D viewer throws", async () => {
    // Suppress the expected React error-boundary console.error noise for
    // this throw so test output stays clean -- the assertion below is what
    // actually proves the boundary caught it. A persistent (not "once")
    // implementation matters here: React retries a thrown render once,
    // synchronously, before handing off to the boundary, so a `mockImplementationOnce`
    // throw would only fire on the first attempt and the retry would then
    // render normally, masking the very crash this test exists to catch.
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    modelViewerMock.mockImplementation(() => {
      throw new Error("bad glb");
    });
    const file = fakeFile({ glb_status: "ok", blob_hash: "badhash" });

    render(<ViewerTab model={fakeModel([file])} />);

    expect(await screen.findByText("Preview failed to load")).toBeInTheDocument();
    modelViewerMock.mockImplementation(defaultModelViewerImpl);
    consoleSpy.mockRestore();
  });

  it("clears a previous crash once the checked parts change to a working set", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    modelViewerMock.mockImplementation(({ urls }: { urls: string[]; background: string }) => {
      if (urls.some((url) => url.includes("badhash"))) throw new Error("bad glb");
      return defaultModelViewerImpl({ urls, background: "#a1a1aa" });
    });
    const fileA = fakeFile({ id: 1, rel_path: "a.stl", blob_hash: "badhash", glb_status: "ok" });
    const fileB = fakeFile({ id: 2, rel_path: "b.stl", blob_hash: "goodhash", glb_status: "ok" });
    render(<ViewerTab model={fakeModel([fileA, fileB])} />);

    expect(await screen.findByText("Preview failed to load")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "a.stl" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "b.stl" }));

    expect(await screen.findByTestId("model-viewer")).toHaveTextContent("/api/blobs/goodhash/glb");
    modelViewerMock.mockImplementation(defaultModelViewerImpl);
    consoleSpy.mockRestore();
  });
});
