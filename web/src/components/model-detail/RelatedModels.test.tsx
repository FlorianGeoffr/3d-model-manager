import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RelatedModels } from "@/components/model-detail/RelatedModels";
import type { ModelDetail, ModelSummary } from "@/api/types";

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, get: getMock },
  };
});

function summary(overrides: Partial<ModelSummary>): ModelSummary {
  return {
    id: 1,
    slug: "model-1",
    name: "Model 1",
    description: null,
    tags: [],
    updated_at: "2026-06-01T12:00:00Z",
    created_at: "2026-06-01T12:00:00Z",
    file_count: 0,
    formats: [],
    cover: null,
    print_time_s: null,
    has_sliced: false,
    source_site: null,
    source_collection_id: null,
    source_collection_title: null,
    favorite: false,
    ...overrides,
  };
}

const MODEL: ModelDetail = {
  id: 1,
  slug: "articulated-dragon",
  name: "Articulated Dragon",
  description: null,
  source_url: null,
  source_site: "thingiverse",
  source_author: null,
  source_license: null,
  source_collection_id: 7,
  source_collection_title: "Dragons I like",
  imported_at: null,
  cover_blob_hash: null,
  is_archived: false,
  created_at: "2026-06-01T12:00:00Z",
  updated_at: "2026-06-01T12:00:00Z",
  tags: [],
  current_revision: null,
  notes: [],
  backends: [],
  favorite: false,
};

function renderRelated(model: ModelDetail) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <RelatedModels model={model} />,
  });
  const detailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/models/$slug", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function lastModelsCall(): string {
  const calls = getMock.mock.calls.filter((call: unknown[]) => (call[0] as string).startsWith("/models"));
  const last = calls.at(-1);
  if (!last) throw new Error("no /models call recorded");
  return last[0] as string;
}

describe("RelatedModels", () => {
  it("renders nothing and fetches nothing when the model has no source collection", () => {
    renderRelated({ ...MODEL, source_collection_id: null });

    expect(screen.queryByTestId("related-models")).not.toBeInTheDocument();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("fetches /models?collection=<id>&limit=6, excludes the current model, and links cards to their detail pages", async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith("/models")) {
        return Promise.resolve({
          items: [
            summary({ id: 1, slug: "articulated-dragon", name: "Articulated Dragon" }),
            summary({ id: 2, slug: "other-dragon", name: "Other Dragon" }),
          ],
          next_cursor: null,
        });
      }
      return Promise.resolve([]);
    });

    renderRelated(MODEL);

    expect(await screen.findByText("More from Dragons I like")).toBeInTheDocument();
    expect(screen.getByText("Other Dragon")).toBeInTheDocument();
    expect(screen.queryByText("Articulated Dragon")).not.toBeInTheDocument();

    expect(lastModelsCall()).toContain("collection=7");
    expect(lastModelsCall()).toContain("limit=6");

    expect(screen.getByRole("link", { name: /Other Dragon/ })).toHaveAttribute("href", "/models/other-dragon");
  });

  it("renders nothing when the filtered list minus self is empty", async () => {
    getMock.mockImplementation((path: string) => {
      if (path.startsWith("/models")) {
        return Promise.resolve({
          items: [summary({ id: 1, slug: "articulated-dragon", name: "Articulated Dragon" })],
          next_cursor: null,
        });
      }
      return Promise.resolve([]);
    });

    renderRelated(MODEL);

    await waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(screen.queryByTestId("related-models")).not.toBeInTheDocument();
  });
});
