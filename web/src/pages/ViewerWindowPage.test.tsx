import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ViewerWindowPage } from "@/pages/ViewerWindowPage";
import type { FileOut, ModelDetail } from "@/api/types";

const { paramsBox, searchBox, modelBox, modelViewerMock } = vi.hoisted(() => ({
  paramsBox: { current: { slug: "dragon" } as { slug?: string } },
  searchBox: { current: {} as { ids?: string; bg?: string; bgc?: string; light?: string; colors?: string } },
  modelBox: { current: { data: undefined as unknown, isLoading: false } },
  modelViewerMock: vi.fn(
    ({
      parts,
      background,
      lighting,
    }: {
      parts: { id: number; url: string; color?: string; visible: boolean }[];
      background: string;
      lighting?: { contactShadow: boolean };
    }) => (
      <div
        data-testid="model-viewer"
        data-background={background}
        data-contact-shadow={lighting ? String(lighting.contactShadow) : undefined}
      >
        {parts.map((part) => `${part.id}:${part.color ?? "none"}`).join(",")}
      </div>
    ),
  ),
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: () => paramsBox.current,
  useSearch: () => searchBox.current,
}));
vi.mock("@/api/library", () => ({ useModel: () => modelBox.current }));
vi.mock("@/components/viewer/ModelViewer", () => ({ default: modelViewerMock }));
// The window now renders the full ViewerStage, which reaches for the printer
// (AMS color sync) and the app theme (the "Match theme" background). Neither
// is under test here -- stub both to a quiet default so the stage mounts.
vi.mock("@/api/printers", () => ({
  usePrinters: () => ({ data: [] }),
  usePrinterStatus: () => ({ data: undefined }),
}));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

function glbFile(id: number, hash: string, rel: string): FileOut {
  return {
    id,
    revision_id: 1,
    rel_path: rel,
    storage_path: "",
    blob_hash: hash,
    size: 1,
    format: "glb",
    kind: "mesh",
    mtime: null,
    verified_at: null,
    meta: null,
    thumb_ready: true,
    glb_status: "ok",
    glb_preview_ready: false,
  } as unknown as FileOut;
}

function fakeModel(files: FileOut[]): ModelDetail {
  return { current_revision: { files } } as unknown as ModelDetail;
}

beforeEach(() => {
  modelViewerMock.mockClear();
  localStorage.clear();
  paramsBox.current = { slug: "dragon" };
  searchBox.current = {};
  modelBox.current = { data: undefined, isLoading: false };
});

describe("ViewerWindowPage", () => {
  it("renders only the requested ids, with their colors and background from the URL", async () => {
    modelBox.current = {
      data: fakeModel([glbFile(1, "aaa", "a.glb"), glbFile(2, "bbb", "b.glb")]),
      isLoading: false,
    };
    searchBox.current = { ids: "2", bg: "#112233", colors: "2:ff0000" };

    render(<ViewerWindowPage />);

    const viewer = await screen.findByTestId("model-viewer");
    expect(viewer).toHaveAttribute("data-background", "#112233");
    // B1 "toggle-fix core": every combinable part is always in `parts` --
    // only id 2 (the requested one) is `visible`; colors still flow to the
    // matching part regardless.
    const parts = modelViewerMock.mock.calls.at(-1)?.[0].parts;
    expect(parts).toEqual([
      { id: 1, url: "/api/blobs/aaa/glb", color: undefined, visible: false },
      { id: 2, url: "/api/blobs/bbb/glb", color: "#ff0000", visible: true },
    ]);
  });

  it("renders every GLB part when no ids are given, with the default background", async () => {
    modelBox.current = {
      data: fakeModel([glbFile(1, "aaa", "a.glb"), glbFile(2, "bbb", "b.glb")]),
      isLoading: false,
    };

    render(<ViewerWindowPage />);

    const viewer = await screen.findByTestId("model-viewer");
    expect(viewer).toHaveAttribute("data-background", "#a1a1aa");
    const parts = modelViewerMock.mock.calls.at(-1)?.[0].parts;
    expect((parts ?? []).map((part: { id: number }) => part.id)).toEqual([1, 2]);
  });

  it("shows a not-found message when the model is missing", async () => {
    modelBox.current = { data: undefined, isLoading: false };
    render(<ViewerWindowPage />);
    expect(await screen.findByText("Model not found.")).toBeInTheDocument();
    expect(screen.queryByTestId("model-viewer")).not.toBeInTheDocument();
  });

  it("renders the full stage -- parts checklist and appearance controls -- not a bare canvas", async () => {
    modelBox.current = {
      data: fakeModel([glbFile(1, "aaa", "a.glb"), glbFile(2, "bbb", "b.glb")]),
      isLoading: false,
    };
    searchBox.current = { ids: "1" };

    render(<ViewerWindowPage />);

    await screen.findByTestId("model-viewer");
    expect(screen.getByRole("radiogroup", { name: "Background" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Lighting" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "a.glb" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "b.glb" })).not.toBeChecked();
  });

  it("checking another part in the window marks it visible in the rendered parts", async () => {
    // B1 "toggle-fix core": both parts are always in `parts` (checking id 1
    // via `ids=1` doesn't drop id 2) -- checking the second part's checkbox
    // only flips its `visible` flag.
    modelBox.current = {
      data: fakeModel([glbFile(1, "aaa", "a.glb"), glbFile(2, "bbb", "b.glb")]),
      isLoading: false,
    };
    searchBox.current = { ids: "1" };

    render(<ViewerWindowPage />);
    await screen.findByTestId("model-viewer");

    const before = modelViewerMock.mock.calls.at(-1)?.[0].parts;
    expect((before ?? []).map((part: { id: number; visible: boolean }) => [part.id, part.visible])).toEqual([
      [1, true],
      [2, false],
    ]);

    fireEvent.click(screen.getByRole("checkbox", { name: "b.glb" }));

    await waitFor(() => {
      const parts = modelViewerMock.mock.calls.at(-1)?.[0].parts;
      expect((parts ?? []).map((part: { id: number; visible: boolean }) => [part.id, part.visible])).toEqual([
        [1, true],
        [2, true],
      ]);
    });
  });

  it("resolves the white background preset from the URL", async () => {
    modelBox.current = { data: fakeModel([glbFile(1, "aaa", "a.glb")]), isLoading: false };
    searchBox.current = { bg: "white" };

    render(<ViewerWindowPage />);

    expect(await screen.findByTestId("model-viewer")).toHaveAttribute("data-background", "#ffffff");
  });

  it("does not persist appearance changes -- the window is a URL-derived view, not the tab's prefs", async () => {
    modelBox.current = { data: fakeModel([glbFile(1, "aaa", "a.glb")]), isLoading: false };
    // No light param -> seeds studio (shadow on).
    render(<ViewerWindowPage />);
    await screen.findByTestId("model-viewer");

    // "Flat" is unique to the Lighting group. Switching it proves the change
    // took effect in-window...
    fireEvent.click(screen.getByRole("radio", { name: "Flat" }));
    await waitFor(() =>
      expect(screen.getByTestId("model-viewer")).toHaveAttribute("data-contact-shadow", "false"),
    );

    // ...but nothing leaked into the tab's shared localStorage prefs.
    expect(localStorage.getItem("viewer-lighting")).toBeNull();
    expect(localStorage.getItem("viewer-bg")).toBeNull();
  });

  it("the flat lighting preset from the URL turns the contact shadow off; studio (default) keeps it on", async () => {
    modelBox.current = { data: fakeModel([glbFile(1, "aaa", "a.glb")]), isLoading: false };
    searchBox.current = { light: "flat" };

    const { unmount } = render(<ViewerWindowPage />);
    expect(await screen.findByTestId("model-viewer")).toHaveAttribute("data-contact-shadow", "false");
    unmount();

    searchBox.current = {};
    render(<ViewerWindowPage />);
    expect(await screen.findByTestId("model-viewer")).toHaveAttribute("data-contact-shadow", "true");
  });
});
