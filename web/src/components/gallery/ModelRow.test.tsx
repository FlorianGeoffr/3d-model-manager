import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ModelRow } from "@/components/gallery/ModelRow";
import type { ModelSummary } from "@/api/types";

const { patchMock, getMock } = vi.hoisted(() => ({
  patchMock: vi.fn().mockResolvedValue({}),
  getMock: vi.fn((path: string) => Promise.resolve(path === "/tags" ? [] : {})),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, patch: patchMock, get: getMock },
  };
});

const MODEL: ModelSummary = {
  id: 1,
  slug: "articulated-dragon",
  name: "Articulated Dragon",
  description: null,
  tags: ["fantasy", "dragon"],
  updated_at: "2026-06-01T12:00:00Z",
  created_at: "2026-05-01T12:00:00Z",
  file_count: 3,
  formats: ["stl", "3mf"],
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

function renderRow(
  model: ModelSummary,
  rowProps: {
    selected?: boolean;
    onSelectChange?: (id: number, next: boolean) => void;
    index?: number;
    onModifiedClick?: (event: React.MouseEvent, index: number) => void;
  } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const rowRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <ModelRow model={model} {...rowProps} />,
  });
  const detailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/models/$slug", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([rowRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return {
    router,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  patchMock.mockClear();
  getMock.mockClear();
});

describe("ModelRow", () => {
  it("renders name, tags, file count, and updated date", async () => {
    renderRow(MODEL);

    expect(await screen.findByText("Articulated Dragon")).toBeInTheDocument();
    expect(screen.getByText("fantasy")).toBeInTheDocument();
    expect(screen.getByText("dragon")).toBeInTheDocument();
    expect(screen.getByText("3 files")).toBeInTheDocument();
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
  });

  it("shows a category badge when the model has one", async () => {
    renderRow({ ...MODEL, category: { id: 1, name: "Miniatures", color: "red", model_count: 1 } });

    expect(await screen.findByText("Miniatures")).toBeInTheDocument();
  });

  it("renders no category badge when the model has none", async () => {
    renderRow(MODEL);

    await screen.findByText("Articulated Dragon");
    expect(screen.queryByText("Miniatures")).not.toBeInTheDocument();
  });

  it("always mounts a select checkbox and calls onSelectChange without navigating", async () => {
    const onSelectChange = vi.fn();
    const { router } = renderRow(MODEL, { selected: false, onSelectChange });

    const checkbox = await screen.findByRole("checkbox", { name: "Select Articulated Dragon" });
    fireEvent.click(checkbox);

    expect(onSelectChange).toHaveBeenCalledExactlyOnceWith(1, true);
    expect(router.state.location.pathname).toBe("/");
  });

  it("renders the checkbox as checked when selected", async () => {
    renderRow(MODEL, { selected: true, onSelectChange: vi.fn() });

    expect(await screen.findByRole("checkbox", { name: "Select Articulated Dragon" })).toBeChecked();
  });

  it("clicking the star PATCHes the toggled favorite value without navigating", async () => {
    const { router } = renderRow(MODEL);

    fireEvent.click(await screen.findByRole("button", { name: "Add to favorites" }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledExactlyOnceWith("/models/articulated-dragon", { favorite: true }),
    );
    expect(router.state.location.pathname).toBe("/");
  });

  it("calls onModifiedClick with the index and prevents navigation on a shift-click", async () => {
    const onModifiedClick = vi.fn();
    const { router } = renderRow(MODEL, { index: 3, onModifiedClick });
    const link = await screen.findByRole("link");

    fireEvent.click(link, { shiftKey: true });

    expect(onModifiedClick).toHaveBeenCalledTimes(1);
    expect(onModifiedClick.mock.calls[0][1]).toBe(3);
    expect(router.state.location.pathname).toBe("/");
  });

  it("plain clicks navigate normally and don't call onModifiedClick", async () => {
    const onModifiedClick = vi.fn();
    renderRow(MODEL, { index: 0, onModifiedClick });
    const link = await screen.findByRole("link");

    fireEvent.click(link);

    expect(onModifiedClick).not.toHaveBeenCalled();
  });
});
