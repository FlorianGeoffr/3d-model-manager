import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FolderBrowser } from "@/components/gallery/FolderBrowser";
import type { StorageTreeOut } from "@/api/types";

const { treesBox, getMock } = vi.hoisted(() => {
  const model = {
    id: 1,
    slug: "goblin",
    name: "Goblin",
    description: null,
    tags: [],
    updated_at: "2026-06-01T12:00:00Z",
    created_at: "2026-05-01T12:00:00Z",
    file_count: 1,
    formats: ["stl"],
    cover: null,
    render_url: null,
    print_time_s: null,
    has_sliced: false,
    source_site: null,
    source_collection_id: null,
    source_collection_title: null,
    favorite: false,
    dims_mm: null,
    best_slicer_file: null,
    printable_file: null,
  };
  return {
    treesBox: {
      current: {
        "": { path: "", dirs: [{ name: "figures", count: 4 }], models: [] },
        figures: { path: "figures", dirs: [{ name: "dnd", count: 2 }], models: [model] },
      } as Record<string, StorageTreeOut>,
    },
    getMock: vi.fn((path: string) => Promise.resolve(path === "/tags" ? [] : {})),
  };
});

vi.mock("@/api/storageTree", () => ({
  useStorageTree: (path: string) => ({
    data: treesBox.current[path] ?? { path, dirs: [], models: [] },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

// `ModelCard` (rendered for leaf models) calls `usePatchModel`/`useTagColorMap`,
// which go through the real `api` client -- stub it the same way
// ModelCard.test.tsx does so those calls resolve harmlessly.
vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, get: getMock },
  };
});

function renderBrowser(path: string, onNavigate = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <FolderBrowser path={path} onNavigate={onNavigate} selectedIds={new Set()} onSelectChange={vi.fn()} />
    ),
  });
  const modelRoute = createRoute({ getParentRoute: () => rootRoute, path: "/models/$slug", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, modelRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return {
    onNavigate,
    router,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  getMock.mockClear();
});

describe("FolderBrowser", () => {
  it("renders subfolders as cards with their model counts", async () => {
    renderBrowser("");

    expect(await screen.findByText("figures")).toBeInTheDocument();
    expect(screen.getByText("4 models")).toBeInTheDocument();
  });

  it("navigates into a subfolder when its card is clicked", async () => {
    const { onNavigate } = renderBrowser("");

    fireEvent.click(await screen.findByText("figures"));

    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("figures");
  });

  it("renders models directly in a folder as ModelCards, and a breadcrumb for the path", async () => {
    renderBrowser("figures");

    expect(await screen.findByText("Goblin")).toBeInTheDocument();
    expect(screen.getByText("dnd")).toBeInTheDocument();
    const breadcrumb = screen.getByRole("navigation", { name: "Folder path" });
    expect(breadcrumb).toHaveTextContent("Library");
    expect(breadcrumb).toHaveTextContent("figures");
  });

  it("navigates to the root when the Library breadcrumb is clicked", async () => {
    const { onNavigate } = renderBrowser("figures");
    await screen.findByText("Goblin");

    fireEvent.click(screen.getByRole("button", { name: "Library" }));

    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("");
  });

  it("filters folders and models by the in-folder text filter, client-side", async () => {
    renderBrowser("figures");
    await screen.findByText("Goblin");

    fireEvent.change(screen.getByLabelText("Filter this folder"), { target: { value: "dnd" } });

    await waitFor(() => expect(screen.queryByText("Goblin")).not.toBeInTheDocument());
    expect(screen.getByText("dnd")).toBeInTheDocument();
  });

  it("shows an empty state when a folder has no subfolders or models", async () => {
    renderBrowser("figures/dnd");

    expect(await screen.findByText("This folder is empty")).toBeInTheDocument();
  });
});
