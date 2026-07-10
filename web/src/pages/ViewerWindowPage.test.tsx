import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ViewerWindowPage } from "@/pages/ViewerWindowPage";
import type { FileOut, ModelDetail } from "@/api/types";

const { paramsBox, searchBox, modelBox, modelViewerMock } = vi.hoisted(() => ({
  paramsBox: { current: { slug: "dragon" } as { slug?: string } },
  searchBox: { current: {} as { ids?: string; bg?: string; colors?: string } },
  modelBox: { current: { data: undefined as unknown, isLoading: false } },
  modelViewerMock: vi.fn(
    ({ parts, background }: { parts: { id: number; url: string; color?: string }[]; background: string }) => (
      <div data-testid="model-viewer" data-background={background}>
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
    const parts = modelViewerMock.mock.calls.at(-1)?.[0].parts;
    expect(parts).toEqual([{ id: 2, url: "/api/blobs/bbb/glb", color: "#ff0000" }]);
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
});
