import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ModelHeader } from "@/components/model-detail/ModelHeader";
import type { ModelDetail } from "@/api/types";

const { getMock, patchMock, deleteMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn().mockResolvedValue([]),
  patchMock: vi.fn().mockResolvedValue({}),
  deleteMock: vi.fn().mockResolvedValue(undefined),
  postMock: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, get: getMock, patch: patchMock, delete: deleteMock, post: postMock },
  };
});

const MODEL: ModelDetail = {
  id: 1,
  slug: "articulated-dragon",
  name: "Articulated Dragon",
  description: "A flexible print-in-place dragon",
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
  tags: ["fantasy", "dragon"],
  current_revision: null,
  notes: [],
  backends: [],
  favorite: false,
};

function renderHeader(editMode: boolean, onToggleEditMode = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <ModelHeader model={MODEL} editMode={editMode} onToggleEditMode={onToggleEditMode} />
    ),
  });
  const jobsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/jobs", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, jobsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return {
    onToggleEditMode,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  getMock.mockClear();
  patchMock.mockClear();
  deleteMock.mockClear();
  postMock.mockClear();
});

describe("ModelHeader -- read-only by default", () => {
  it("renders name and description as plain text, no editing affordances", async () => {
    renderHeader(false);

    const heading = await screen.findByRole("heading", { name: "Articulated Dragon" });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText("A flexible print-in-place dragon")).toBeInTheDocument();

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit name|Edit description/ })).not.toBeInTheDocument();
    // Name/description aren't clickable buttons anymore.
    expect(screen.queryByRole("button", { name: "Articulated Dragon" })).not.toBeInTheDocument();
  });

  it("hides tag remove buttons and the Archive button", async () => {
    renderHeader(false);

    await screen.findByText("fantasy");
    expect(screen.queryByRole("button", { name: /Remove tag/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add tag" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  it("shows an outline Edit toggle button", async () => {
    renderHeader(false);

    const toggle = await screen.findByRole("button", { name: "Edit" });
    expect(toggle).toBeInTheDocument();
  });

  it("shows the favorite star, and an Add to queue action, even in read-only mode", async () => {
    renderHeader(false);

    expect(await screen.findByRole("button", { name: "Add to favorites" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to queue" })).toBeInTheDocument();
  });
});

describe("ModelHeader -- edit mode", () => {
  it("toggling Edit calls onToggleEditMode", async () => {
    const { onToggleEditMode } = renderHeader(false);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    expect(onToggleEditMode).toHaveBeenCalledOnce();
  });

  it("reveals editing affordances for name/description, tags, and Archive; toggle reads Done", async () => {
    renderHeader(true);

    expect(await screen.findByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit name" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit description" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove tag fantasy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add tag" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
  });

  it("keeps the name as a level-1 heading in edit mode", async () => {
    renderHeader(true);

    // The heading's accessible name also picks up the embedded pencil
    // button's label, so match on the model name rather than exactly.
    const heading = await screen.findByRole("heading", { level: 1, name: /Articulated Dragon/ });
    expect(heading).toBeInTheDocument();
  });

  it("archiving still requires confirmation and calls the archive endpoint", async () => {
    renderHeader(true);

    fireEvent.click(await screen.findByRole("button", { name: "Archive" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText('Archive "Articulated Dragon"?')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledExactlyOnceWith("/models/articulated-dragon"));
  });

  it("editing the name commits through InlineEdit's explicit Save", async () => {
    renderHeader(true);

    fireEvent.click(await screen.findByRole("button", { name: "Edit name" }));
    const input = screen.getByRole("textbox", { name: "name" });
    fireEvent.change(input, { target: { value: "New Name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledExactlyOnceWith("/models/articulated-dragon", { name: "New Name" }),
    );
  });

  it("still shows the favorite star in edit mode -- it isn't gated by the edit toggle", async () => {
    renderHeader(true);

    expect(await screen.findByRole("button", { name: "Add to favorites" })).toBeInTheDocument();
  });
});

describe("ModelHeader -- favorite + queue actions", () => {
  it("toggling the favorite star PATCHes favorite:true, without touching the edit gate", async () => {
    renderHeader(false);

    fireEvent.click(await screen.findByRole("button", { name: "Add to favorites" }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledExactlyOnceWith("/models/articulated-dragon", { favorite: true }),
    );
  });

  it("'Add to queue' posts the model id to the queue endpoint", async () => {
    renderHeader(false);

    fireEvent.click(await screen.findByRole("button", { name: "Add to queue" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledExactlyOnceWith("/queue", { model_id: 1 }));
  });
});
