import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, useEffect, type ReactNode } from "react";

import { ViewerTab } from "@/components/model-detail/ViewerTab";
import type { FileOut, ModelDetail } from "@/api/types";

// `ModelViewer` is a `React.lazy` chunk that mounts an R3F `<Canvas>`, which
// jsdom can't run (no WebGL) -- stub it so ViewerTab's branching logic can
// be exercised without ever touching three.js. It now takes multiple parts
// (Workstream A "multi-part combined view"), each `{ id, url, color?,
// visible }`, plus a resolved background color -- render the joined urls +
// the color onto the stub so tests can assert on them (same joined-url shape
// as before). The joined `data-colors` (B1 "per-part recolor via the
// FilamentChip swatch") lets recolor tests assert per-part colors reach the
// viewer without a real mock per test. `data-parts` (B1 "toggle-fix core")
// exposes each part's `visible` flag -- every combinable part is ALWAYS in
// `parts` now (checked or not), so tests that used to assert on which urls
// were present/absent assert on `visible` here instead. `data-grid`/
// `data-auto-rotate`/`data-ortho` (B1 Task 3/4 "viewer tools state") expose
// the matching `tools` flags `useViewerScene` hands down, so a test can
// assert them without reaching into `tools.ts` directly. `data-fit` (B1
// Task 4) exposes the `fitSignal` counter -- bumped by the Fit view
// button/`F` key and the ortho toggle's post-swap recovery. `onStats` is
// real (not stubbed away) -- it's `useViewerScene`'s `setStats`, passed
// straight through -- so a test can grab it off `modelViewerMock.mock.calls`
// and drive the real stats overlay chip `ViewerStage` renders, the same way
// the real component would. The mock also publishes `apiRef.current = {
// screenshot: screenshotSpy }` synchronously in its body -- standing in for
// the real `ModelViewer`'s `CaptureBridge` effect -- so the Screenshot
// button's click handler has something to call.
type ViewerPart = { id: number; url: string; color?: string; visible: boolean };
type ViewerLighting = { contactShadow: boolean };
type ViewerToolsStub = {
  grid: boolean;
  autoRotate: boolean;
  ortho: boolean;
  wireframe: boolean;
  section: { enabled: boolean; axis: string; t: number };
  explode: number;
};
type ViewerApiStub = { screenshot: () => Promise<Blob | null> };
const { modelViewerMock, platePanelMock, defaultModelViewerImpl, screenshotSpy } = vi.hoisted(() => {
  const screenshotSpy = vi.fn(() => Promise.resolve(new Blob(["fake-png"], { type: "image/png" })));
  const defaultModelViewerImpl = ({
    parts,
    background,
    lighting,
    tools,
    fitSignal,
    apiRef,
  }: {
    parts: ViewerPart[];
    background: string;
    lighting?: ViewerLighting;
    tools?: ViewerToolsStub;
    fitSignal?: number;
    apiRef?: { current: ViewerApiStub | null };
  }) => {
    if (apiRef) apiRef.current = { screenshot: screenshotSpy };
    return (
      <div
        data-testid="model-viewer"
        data-background={background}
        data-contact-shadow={lighting ? String(lighting.contactShadow) : undefined}
        data-colors={parts.map((part) => part.color ?? "").join(",")}
        data-parts={parts.map((part) => `${part.id}:${part.visible ? 1 : 0}`).join(",")}
        data-grid={tools ? String(tools.grid) : undefined}
        data-auto-rotate={tools ? String(tools.autoRotate) : undefined}
        data-ortho={tools ? String(tools.ortho) : undefined}
        data-wireframe={tools ? String(tools.wireframe) : undefined}
        data-section={
          tools ? `${tools.section.enabled}:${tools.section.axis}:${tools.section.t}` : undefined
        }
        data-explode={tools ? String(tools.explode) : undefined}
        data-fit={fitSignal}
      >
        {parts.map((part) => part.url).join(",")}
      </div>
    );
  };
  return {
    modelViewerMock: vi.fn(defaultModelViewerImpl),
    // `PlatePanel` has its own dedicated test suite (PlatePanel.test.tsx) --
    // stub it here so this file only asserts that ViewerTab wires it in for
    // sliced files, not its internals.
    platePanelMock: vi.fn(({ file }: { file: FileOut }) => <div data-testid="plate-panel">{file.rel_path}</div>),
    defaultModelViewerImpl,
    screenshotSpy,
  };
});

vi.mock("@/components/viewer/ModelViewer", () => ({ default: modelViewerMock }));
vi.mock("@/components/model-detail/PlatePanel", () => ({ PlatePanel: platePanelMock }));

// MeshSection queries printers for the AMS color-sync (M8 G3); these tests
// render ViewerTab without a QueryClientProvider, so stub the hooks to "no
// printer" (AMS section then never mounts, and no useQuery runs).
vi.mock("@/api/printers", () => ({
  usePrinters: () => ({ data: [] }),
  usePrinterStatus: () => ({ data: undefined }),
}));

// Radix's Select never reaches an interactive open state under jsdom (same
// floating-ui/dismissable-layer limitation as Popover, which is why the
// Background/Lighting pickers are a `role="radiogroup"` of plain buttons
// instead of a `<Select>` or a `<Popover>` -- see `SegmentedControl` in
// `@/components/viewer/SegmentedControl`) -- swap the remaining `<Select>` (the non-mesh file
// picker) for a native <select> so it can be driven with a plain change
// event. It carries its accessible name via `<SelectTrigger aria-label=...>`,
// so this mock pulls that label off whichever child element declares it and
// puts it on the native `<select>` -- letting `getByRole("combobox", { name
// })` find it.
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
  };
}

describe("ViewerTab", () => {
  beforeEach(() => {
    modelViewerMock.mockClear();
    platePanelMock.mockClear();
    screenshotSpy.mockClear();
    localStorage.clear();
  });

  // Background and Lighting are now two separate segmented controls in the
  // panel, and both have a "Studio" segment -- so radio queries must be scoped
  // to the group under test or they match across both.
  const bgGroup = () => screen.getByRole("radiogroup", { name: "Background" });
  const lightGroup = () => screen.getByRole("radiogroup", { name: "Lighting" });

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

  it("passes the default viewer tools (build-plate grid on) to ModelViewer", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);

    expect(await screen.findByTestId("model-viewer")).toHaveAttribute("data-grid", "true");
  });

  it("Fit view bumps the fit signal ModelViewer receives", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-fit", "0");

    fireEvent.click(screen.getByRole("button", { name: "Fit view" }));

    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-fit", "1"));
  });

  it("the F key on the canvas wrapper also bumps the fit signal", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.keyDown(screen.getByTestId("model-viewer").parentElement!, { key: "f" });

    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-fit", "1"));
  });

  it("visibility toggles never bump the fit signal; an explicit Fit after one still does", async () => {
    // The visible-parts camera fit (ModelViewer's `getVisibleBox`) relies on
    // this stage-side contract: checking/unchecking a part must NOT trigger
    // a refit by itself (framing stays put), and the NEXT explicit Fit is
    // what picks up the new visible set. The geometry itself needs a real
    // canvas -- verified live -- but the signal plumbing pins here.
    const fileA = fakeFile({ id: 1, rel_path: "a.stl", blob_hash: "hashA", glb_status: "ok" });
    const fileB = fakeFile({ id: 2, rel_path: "b.stl", blob_hash: "hashB", glb_status: "ok" });
    render(<ViewerTab model={fakeModel([fileA, fileB])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.click(screen.getByRole("checkbox", { name: "b.stl" }));
    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-parts", "1:1,2:1"));
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-fit", "0");

    fireEvent.click(screen.getByRole("button", { name: "Fit view" }));
    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-fit", "1"));
  });

  it("Auto-rotate flips aria-pressed and the tools.autoRotate flag ModelViewer receives", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    const button = screen.getByRole("button", { name: "Auto-rotate" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-auto-rotate", "false");

    fireEvent.click(button);

    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-auto-rotate", "true");
  });

  it("the R key on the canvas wrapper toggles auto-rotate", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.keyDown(screen.getByTestId("model-viewer").parentElement!, { key: "r" });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Auto-rotate" })).toHaveAttribute("aria-pressed", "true"),
    );
  });

  it("Orthographic camera flips tools.ortho and also bumps the fit signal (camera swap resets framing)", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    const button = screen.getByRole("button", { name: "Orthographic camera" });
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-ortho", "false");
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-fit", "0");

    fireEvent.click(button);

    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-ortho", "true"));
    expect(button).toHaveAttribute("aria-pressed", "true");
    // The camera swap resets `OrbitControls`' target -- the ortho handler
    // fires a follow-up fit to recover framing, so `fitSignal` bumps too.
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-fit", "1");
  });

  it("Wireframe flips aria-pressed and the tools.wireframe flag ModelViewer receives", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    const button = screen.getByRole("button", { name: "Wireframe" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-wireframe", "false");

    fireEvent.click(button);

    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-wireframe", "true");
  });

  it("the W key on the canvas wrapper toggles wireframe", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.keyDown(screen.getByTestId("model-viewer").parentElement!, { key: "w" });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Wireframe" })).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-wireframe", "true");
  });

  it("Grid flips aria-pressed and the tools.grid flag ModelViewer receives", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    const button = screen.getByRole("button", { name: "Grid" });
    // Grid defaults on.
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-grid", "true");

    fireEvent.click(button);

    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "false"));
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-grid", "false");
  });

  it("the G key on the canvas wrapper toggles the grid", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.keyDown(screen.getByTestId("model-viewer").parentElement!, { key: "g" });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Grid" })).toHaveAttribute("aria-pressed", "false"),
    );
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-grid", "false");
  });

  it("enabling Section reveals the axis control and position slider, both flowing to the mock", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    // Off by default: no axis picker, no position slider, disabled in the mock.
    expect(screen.queryByRole("radiogroup", { name: "Axis" })).not.toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Section position" })).not.toBeInTheDocument();
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-section", "false:x:0.5");

    fireEvent.click(screen.getByRole("checkbox", { name: "Section" }));

    expect(await screen.findByRole("radiogroup", { name: "Axis" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "Section position" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-section", "true:x:0.5"),
    );
  });

  it("moving the section slider and switching the axis both update the mock's section state", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.click(screen.getByRole("checkbox", { name: "Section" }));
    await screen.findByRole("radiogroup", { name: "Axis" });

    fireEvent.click(screen.getByRole("radio", { name: "Y" }));
    await waitFor(() =>
      expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-section", "true:y:0.5"),
    );

    fireEvent.change(screen.getByRole("slider", { name: "Section position" }), {
      target: { value: "0.25" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-section", "true:y:0.25"),
    );
  });

  it("Explode is absent with a single GLB part", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    expect(screen.queryByRole("slider", { name: "Explode" })).not.toBeInTheDocument();
  });

  it("Explode appears with two GLB parts and its slider updates tools.explode", async () => {
    const fileA = fakeFile({ id: 1, rel_path: "a.stl", blob_hash: "hashA", glb_status: "ok" });
    const fileB = fakeFile({ id: 2, rel_path: "b.stl", blob_hash: "hashB", glb_status: "ok" });
    render(<ViewerTab model={fakeModel([fileA, fileB])} />);
    await screen.findByTestId("model-viewer");

    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-explode", "0");

    const slider = screen.getByRole("slider", { name: "Explode" });
    fireEvent.change(slider, { target: { value: "0.6" } });

    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-explode", "0.6"));
  });

  it("explode sticks across re-renders; onPartLoaded only resets it when actually fired", async () => {
    // Regression: `ViewerStage` re-creates its `onPartLoaded` handler
    // whenever `tools.explode` changes (it closes over it). The real
    // `ModelViewer` keeps its part-load callback identity-stable and fires
    // `onPartLoaded` only on a part's FIRST load -- if it instead re-fired
    // on every handler-identity change, the reset-if-nonzero logic would
    // snap the slider straight back to 0 the moment it moved (the mock here
    // stands in for `ModelViewer`, so this test pins the `ViewerStage` side
    // of that contract: re-renders alone never reset explode; an explicit
    // `onPartLoaded()` call does).
    const fileA = fakeFile({ id: 1, rel_path: "a.stl", blob_hash: "hashA", glb_status: "ok" });
    const fileB = fakeFile({ id: 2, rel_path: "b.stl", blob_hash: "hashB", glb_status: "ok" });
    render(<ViewerTab model={fakeModel([fileA, fileB])} />);
    await screen.findByTestId("model-viewer");

    const partLoaded = () => {
      const { onPartLoaded } = modelViewerMock.mock.calls.at(-1)![0] as unknown as {
        onPartLoaded: () => void;
      };
      act(() => onPartLoaded());
    };

    // The initial eager load fires it while explode is still 0 -- harmless.
    partLoaded();
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-explode", "0");

    fireEvent.change(screen.getByRole("slider", { name: "Explode" }), { target: { value: "0.6" } });
    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-explode", "0.6"));

    // Unrelated tool changes re-render the stage and hand ModelViewer a NEW
    // `onPartLoaded` identity -- explode must stay where the slider put it.
    fireEvent.click(screen.getByRole("button", { name: "Wireframe" }));
    await waitFor(() =>
      expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-wireframe", "true"),
    );
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-explode", "0.6");

    // A genuine late FIRST load is the one thing that resets it (the
    // just-arrived part would otherwise render detached from the exploded
    // scene).
    partLoaded();
    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-explode", "0"));
  });

  it("Screenshot calls the published screenshot bridge and downloads the resulting PNG", async () => {
    const createObjectURLSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
    const revokeObjectURLSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.click(screen.getByRole("button", { name: "Screenshot" }));

    await waitFor(() => expect(screenshotSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(createObjectURLSpy).toHaveBeenCalledTimes(1));

    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
    clickSpy.mockRestore();
  });

  it("resyncs the first-part-checked default when the model's file set changes", async () => {
    // TanStack Router reuses this component instance across `$slug`
    // navigations, so `checkedIds` must not carry over model A's ids to
    // model B (which would leave every box unchecked). `MeshSection` is keyed
    // on the ready-GLB id set to force a fresh default on any file-set change.
    const modelA = fakeModel([fakeFile({ id: 1, rel_path: "a.stl", blob_hash: "hashA", glb_status: "ok" })]);
    const { rerender } = render(<ViewerTab model={modelA} />);
    expect(await screen.findByRole("checkbox", { name: "a.stl" })).toBeChecked();

    const modelB = fakeModel([fakeFile({ id: 5, rel_path: "z.stl", blob_hash: "hashZ", glb_status: "ok" })]);
    rerender(<ViewerTab model={modelB} />);

    expect(await screen.findByRole("checkbox", { name: "z.stl" })).toBeChecked();
    expect(screen.getByTestId("model-viewer")).toHaveTextContent("/api/blobs/hashZ/glb");
  });

  it("checking a second glb part makes it visible in the combined viewer; unchecking hides it again", async () => {
    // B1 "toggle-fix core": both parts are always mounted in the combined
    // viewer (their urls are always both present) -- checking/unchecking
    // only flips which are `visible`, it never adds/removes a part.
    const fileA = fakeFile({ id: 1, rel_path: "a.stl", blob_hash: "hashA", glb_status: "ok" });
    const fileB = fakeFile({ id: 2, rel_path: "b.stl", blob_hash: "hashB", glb_status: "ok" });
    render(<ViewerTab model={fakeModel([fileA, fileB])} />);

    // Only the first part is checked by default.
    expect(await screen.findByTestId("model-viewer")).toHaveTextContent(
      "/api/blobs/hashA/glb,/api/blobs/hashB/glb",
    );
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-parts", "1:1,2:0");
    expect(screen.getByRole("checkbox", { name: "b.stl" })).not.toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", { name: "b.stl" }));
    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-parts", "1:1,2:1"));

    fireEvent.click(screen.getByRole("checkbox", { name: "a.stl" }));
    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-parts", "1:0,2:1"));
    // Both urls stay present the whole time -- neither part ever unmounts.
    expect(screen.getByTestId("model-viewer")).toHaveTextContent(
      "/api/blobs/hashA/glb,/api/blobs/hashB/glb",
    );
  });

  it("toggling a part checkbox updates the mounted viewer's visibility without remounting it", async () => {
    // The regression B1 exists to fix: the whole canvas (WebGL context, IBL
    // bake, camera) used to remount on every checkbox click because the
    // error boundary above it was keyed on the checked-id set.
    const mountSpy = vi.fn();
    function SpyModelViewer({ parts }: { parts: ViewerPart[] }) {
      useEffect(() => {
        mountSpy();
      }, []);
      return (
        <div data-testid="model-viewer" data-parts={parts.map((part) => `${part.id}:${part.visible ? 1 : 0}`).join(",")} />
      );
    }
    modelViewerMock.mockImplementation(SpyModelViewer);

    const fileA = fakeFile({ id: 1, rel_path: "a.stl", blob_hash: "hashA", glb_status: "ok" });
    const fileB = fakeFile({ id: 2, rel_path: "b.stl", blob_hash: "hashB", glb_status: "ok" });
    render(<ViewerTab model={fakeModel([fileA, fileB])} />);
    await screen.findByTestId("model-viewer");
    expect(mountSpy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("checkbox", { name: "b.stl" }));

    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-parts", "1:1,2:1"));
    expect(mountSpy).toHaveBeenCalledTimes(1);

    modelViewerMock.mockImplementation(defaultModelViewerImpl);
  });

  it("shows the checked/total part count in the panel header, updating as parts are checked", async () => {
    const fileA = fakeFile({ id: 1, rel_path: "a.stl", blob_hash: "hashA", glb_status: "ok" });
    const fileB = fakeFile({ id: 2, rel_path: "b.stl", blob_hash: "hashB", glb_status: "ok" });
    const fileC = fakeFile({ id: 3, rel_path: "c.stl", blob_hash: "hashC", glb_status: "ok" });
    render(<ViewerTab model={fakeModel([fileA, fileB, fileC])} />);
    await screen.findByTestId("model-viewer");

    // Only the first part is checked by default.
    expect(screen.getByText("1 of 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "b.stl" }));

    expect(await screen.findByText("2 of 3")).toBeInTheDocument();
  });

  it("unchecking every part keeps the viewer mounted and shows a 'No parts selected' hint", async () => {
    // B1 "toggle-fix core": unmounting the canvas here would tear down the
    // WebGL context, IBL bake, and camera for no reason -- it stays mounted
    // with every part hidden, and a hint overlays it instead.
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.click(screen.getByRole("checkbox", { name: file.rel_path }));

    expect(await screen.findByText("No parts selected")).toBeInTheDocument();
    expect(screen.getByTestId("model-viewer")).toBeInTheDocument();
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-parts", "1:0");
  });

  it("shows the scene-stats chip once ModelViewer reports stats, and hides it again on null", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    // No stats reported yet -- the chip doesn't render at all.
    expect(screen.queryByTestId("scene-stats")).not.toBeInTheDocument();

    const { onStats } = modelViewerMock.mock.calls.at(-1)![0] as unknown as {
      onStats: (stats: { x: number; y: number; z: number; triangles: number } | null) => void;
    };

    act(() => onStats({ x: 220.4, y: 180, z: 45.2, triangles: 1_200_000 }));
    expect(await screen.findByTestId("scene-stats")).toHaveTextContent(
      "220.4 × 180.0 × 45.2 mm · 1.2M tris",
    );

    act(() => onStats(null));
    expect(screen.queryByTestId("scene-stats")).not.toBeInTheDocument();
  });

  it("selecting the White background passes #ffffff to ModelViewer and persists the choice", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.click(within(bgGroup()).getByRole("radio", { name: "White" }));

    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-background", "#ffffff"));
    expect(JSON.parse(localStorage.getItem("viewer-bg") ?? "{}")).toMatchObject({ preset: "white" });
  });

  it("pressing ArrowRight on the selected Background segment selects the next preset", async () => {
    // Roving-tabindex contract (ARIA APG radiogroup): arrow keys move focus
    // AND change the selection, not just focus. Default preset is Studio, so
    // ArrowRight should land on White and resolve to #ffffff.
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.keyDown(within(bgGroup()).getByRole("radio", { name: "Studio" }), { key: "ArrowRight" });

    const white = within(bgGroup()).getByRole("radio", { name: "White" });
    await waitFor(() => expect(white).toHaveAttribute("aria-checked", "true"));
    expect(white).toHaveFocus();
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-background", "#ffffff");
  });

  it("pressing ArrowLeft from the first segment wraps around to the last preset", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.keyDown(within(bgGroup()).getByRole("radio", { name: "Studio" }), { key: "ArrowLeft" });

    const custom = within(bgGroup()).getByRole("radio", { name: "Custom" });
    await waitFor(() => expect(custom).toHaveAttribute("aria-checked", "true"));
    expect(custom).toHaveFocus();
  });

  it("keeps only the selected Background segment in the tab order", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    const radios = within(bgGroup()).getAllByRole("radio");
    const tabbable = radios.filter((radio) => radio.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]).toHaveAccessibleName("Studio");
    for (const radio of radios) {
      if (radio !== tabbable[0]) expect(radio).toHaveAttribute("tabindex", "-1");
    }
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

    // The Custom swatch hosts its own invisible `<input type="color">`
    // overlay (Task 6's `BackgroundSwatches`) -- it's `aria-hidden` (so it
    // doesn't add a second stop to the roving-radio tab order alongside its
    // wrapping `role="radio"` swatch), so reach it by DOM position instead
    // of an accessible query.
    const customRadio = within(bgGroup()).getByRole("radio", { name: "Custom" });
    const colorInput = customRadio.querySelector('input[type="color"]') as HTMLInputElement;
    fireEvent.change(colorInput, { target: { value: "#123456" } });

    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-background", "#123456"));
    // Changing the color also selects the Custom preset, even though it
    // wasn't the checked segment beforehand.
    expect(customRadio).toHaveAttribute("aria-checked", "true");
  });

  it("selecting the Bright lighting preset persists it; studio and bright keep the ground shadow", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    // The default studio rig lights with a ground contact shadow.
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-contact-shadow", "true");

    fireEvent.click(within(lightGroup()).getByRole("radio", { name: "Bright" }));

    await waitFor(() => expect(localStorage.getItem("viewer-lighting")).toBe("bright"));
    expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-contact-shadow", "true");
  });

  it("the Flat lighting preset turns the ground contact shadow off", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.click(within(lightGroup()).getByRole("radio", { name: "Flat" }));

    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-contact-shadow", "false"));
  });

  it("opens a pop-out window carrying the background and lighting presets in the URL", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const file = fakeFile({ id: 7, rel_path: "a.stl", blob_hash: "hashA", glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.click(screen.getByRole("button", { name: "New window" }));

    expect(openSpy).toHaveBeenCalledTimes(1);
    const url = String(openSpy.mock.calls[0][0]);
    expect(url).toContain("/viewer/test-model?");
    expect(url).toContain("ids=7");
    // `bg` carries the PRESET now, not a resolved hex, so the window's control
    // lands on the right segment; no `bgc` unless the preset is custom.
    expect(url).toContain("bg=studio");
    expect(url).toContain("light=studio");
    expect(url).not.toContain("bgc=");
    openSpy.mockRestore();
  });

  it("includes the custom background hex in the pop-out URL only when the preset is custom", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const file = fakeFile({ id: 7, rel_path: "a.stl", blob_hash: "hashA", glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    const colorInput = within(bgGroup())
      .getByRole("radio", { name: "Custom" })
      .querySelector('input[type="color"]') as HTMLInputElement;
    fireEvent.change(colorInput, { target: { value: "#123456" } });
    fireEvent.click(screen.getByRole("button", { name: "New window" }));

    const url = String(openSpy.mock.calls.at(-1)?.[0]);
    expect(url).toContain("bg=custom");
    expect(url).toContain("bgc=%23123456");
    openSpy.mockRestore();
  });

  it("openInWindow always carries grid, and only carries wf/rot/sec/ex when they're non-default", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const file = fakeFile({ id: 7, rel_path: "a.stl", blob_hash: "hashA", glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    // Every tools field still at its default -- `grid` (default true) is
    // the one param that's always written; the rest stay out of the URL.
    fireEvent.click(screen.getByRole("button", { name: "New window" }));
    let url = String(openSpy.mock.calls.at(-1)?.[0]);
    expect(url).toContain("grid=1");
    expect(url).not.toContain("wf=");
    expect(url).not.toContain("rot=");
    expect(url).not.toContain("sec=");
    expect(url).not.toContain("ex=");

    // Flip every tool away from its default, then re-open: each param now
    // appears, with `grid=0` reflecting the toggled-off state.
    fireEvent.click(screen.getByRole("button", { name: "Grid" }));
    fireEvent.click(screen.getByRole("button", { name: "Wireframe" }));
    fireEvent.click(screen.getByRole("button", { name: "Auto-rotate" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Section" }));
    await screen.findByRole("radiogroup", { name: "Axis" });
    fireEvent.click(screen.getByRole("radio", { name: "Y" }));
    fireEvent.change(screen.getByRole("slider", { name: "Section position" }), {
      target: { value: "0.25" },
    });

    fireEvent.click(screen.getByRole("button", { name: "New window" }));
    url = String(openSpy.mock.calls.at(-1)?.[0]);
    expect(url).toContain("grid=0");
    expect(url).toContain("wf=1");
    expect(url).toContain("rot=1");
    expect(url).toContain("sec=y%3A0.25");
    expect(url).not.toContain("ex=");

    openSpy.mockRestore();
  });

  it("openInWindow carries ex once the explode slider (only shown with 2+ parts) is moved off 0", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const fileA = fakeFile({ id: 1, rel_path: "a.stl", blob_hash: "hashA", glb_status: "ok" });
    const fileB = fakeFile({ id: 2, rel_path: "b.stl", blob_hash: "hashB", glb_status: "ok" });
    render(<ViewerTab model={fakeModel([fileA, fileB])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.change(screen.getByRole("slider", { name: "Explode" }), { target: { value: "0.4" } });
    fireEvent.click(screen.getByRole("button", { name: "New window" }));

    const url = String(openSpy.mock.calls.at(-1)?.[0]);
    expect(url).toContain("ex=0.40");
    openSpy.mockRestore();
  });

  it("recolors a part via its swatch, persists it, and doesn't bleed onto the other part", async () => {
    const fileA = fakeFile({ id: 1, rel_path: "a.stl", blob_hash: "hashA", glb_status: "ok" });
    const fileB = fakeFile({ id: 2, rel_path: "b.stl", blob_hash: "hashB", glb_status: "ok" });
    render(<ViewerTab model={fakeModel([fileA, fileB])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.click(screen.getByRole("checkbox", { name: "b.stl" }));
    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveTextContent("hashB"));

    fireEvent.change(screen.getByLabelText("Color for a.stl"), { target: { value: "#123456" } });

    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-colors", "#123456,"));
    expect(JSON.parse(localStorage.getItem("viewer-colors:test-model") ?? "{}")).toMatchObject({ "1": "#123456" });
  });

  it("Reset colors clears every part's color; the per-part reset clears only its own", async () => {
    const fileA = fakeFile({ id: 1, rel_path: "a.stl", blob_hash: "hashA", glb_status: "ok" });
    const fileB = fakeFile({ id: 2, rel_path: "b.stl", blob_hash: "hashB", glb_status: "ok" });
    render(<ViewerTab model={fakeModel([fileA, fileB])} />);
    await screen.findByTestId("model-viewer");
    fireEvent.click(screen.getByRole("checkbox", { name: "b.stl" }));
    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveTextContent("hashB"));

    fireEvent.change(screen.getByLabelText("Color for a.stl"), { target: { value: "#111111" } });
    fireEvent.change(screen.getByLabelText("Color for b.stl"), { target: { value: "#222222" } });
    await waitFor(() =>
      expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-colors", "#111111,#222222"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Reset color for a.stl" }));
    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-colors", ",#222222"));
    expect(screen.queryByRole("button", { name: "Reset color for a.stl" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset colors" }));
    await waitFor(() => expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-colors", ","));
    expect(screen.queryByRole("button", { name: "Reset colors" })).not.toBeInTheDocument();
  });

  it("collapsing the parts panel hides it; the reopen control restores it", async () => {
    const file = fakeFile({ glb_status: "ok" });
    render(<ViewerTab model={fakeModel([file])} />);
    await screen.findByTestId("model-viewer");

    expect(screen.getByRole("checkbox", { name: file.rel_path })).toBeInTheDocument();
    // The appearance controls live inside the panel now, so collapsing it
    // takes them with it -- the panel is the single control surface.
    expect(screen.getByRole("radiogroup", { name: "Background" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Lighting" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse panel" }));

    expect(screen.queryByRole("checkbox", { name: file.rel_path })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Background" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Lighting" })).not.toBeInTheDocument();
    const reopen = screen.getByRole("button", { name: "Expand panel" });
    expect(reopen).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(reopen);
    expect(await screen.findByRole("checkbox", { name: file.rel_path })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Background" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse panel" })).toHaveAttribute("aria-expanded", "true");
  });

  it("clicking Expand mounts a dialog containing the same combined viewer, with all its controls", async () => {
    const fileA = fakeFile({ id: 1, rel_path: "a.stl", blob_hash: "hash1", glb_status: "ok" });
    const fileB = fakeFile({ id: 2, rel_path: "b.stl", blob_hash: "hash2", glb_status: "ok" });
    render(<ViewerTab model={fakeModel([fileA, fileB])} />);
    await screen.findByTestId("model-viewer");

    fireEvent.click(screen.getByRole("button", { name: "Expand" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByTestId("model-viewer")).toHaveTextContent("/api/blobs/hash1/glb");
    // The regression B1 exists to fix: Expand used to strip every control.
    expect(within(dialog).getByRole("radiogroup", { name: "Background" })).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "a.stl" })).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: "b.stl" })).toBeInTheDocument();
    // Already expanded -- no point offering Expand again inside the dialog.
    expect(within(dialog).queryByRole("button", { name: "Expand" })).not.toBeInTheDocument();
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
    // B1: every part is always mounted now, so the throw is gated on
    // `visible` (not mere presence) -- otherwise the always-present badhash
    // part would keep throwing even once it's unchecked.
    modelViewerMock.mockImplementation(({ parts }: { parts: ViewerPart[]; background: string }) => {
      if (parts.some((part) => part.visible && part.url.includes("badhash"))) throw new Error("bad glb");
      return defaultModelViewerImpl({ parts, background: "#a1a1aa" });
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
