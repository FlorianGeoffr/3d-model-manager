import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import type { JobUpdatedEvent, ModelDetail, UploadResult } from "@/api/types";
import { TerminalEventMap, UploadPage } from "@/pages/UploadPage";

// `vi.mock` factories are hoisted above the module's own top-level bindings
// (same pattern as LibraryPage.test.tsx), so the fakes have to be created
// through `vi.hoisted`.
const { createModelMock, uploadFileMock, eventsListener } = vi.hoisted(() => ({
  createModelMock: vi.fn(),
  uploadFileMock: vi.fn(),
  // Holds the callback UploadPage's `useEvents().subscribe(...)` registers,
  // so tests can fire a `job.updated` event directly instead of the no-op
  // stub silently discarding it (needed for the SSE race regression test).
  eventsListener: { current: null as ((event: JobUpdatedEvent) => void) | null },
}));

vi.mock("@/api/library", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/library")>();
  return {
    ...actual,
    useCreateModel: () => ({ mutateAsync: createModelMock }),
    // "Existing model" mode: static search results + a network-free
    // modelQueryOptions so TargetPicker's selectExisting can resolve either
    // model without a backend. (fakeModel is a hoisted function declaration,
    // so referencing it from this hoisted factory is safe.)
    useModelSearchQuery: () => ({
      data: {
        items: [
          { id: 1, slug: "model-a", name: "Model A" },
          { id: 2, slug: "model-b", name: "Model B" },
        ],
      },
    }),
    modelQueryOptions: (slug: string) => ({
      queryKey: ["test-model-detail", slug],
      queryFn: async () =>
        slug === "model-b"
          ? fakeModel({
              id: 2,
              slug: "model-b",
              name: "Model B",
              current_revision: { ...fakeModel().current_revision!, id: 20, model_id: 2 },
            })
          : fakeModel({ id: 1, slug: "model-a", name: "Model A" }),
    }),
  };
});

vi.mock("@/api/upload", () => ({ uploadFile: uploadFileMock }));

// Radix's Popover never reaches the open state under jsdom (floating-ui
// positioning + dismissable-layer focus handling both depend on real
// browser behavior), and popover mechanics aren't what these tests
// exercise -- render trigger and content inline unconditionally.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

// UploadPage subscribes to the app-wide SSE connection via `useEvents`,
// which normally requires an `EventsProvider` wrapping a real `EventSource`
// (unavailable in jsdom) -- stub it out, capturing the registered listener
// so the race regression test can fire events directly.
vi.mock("@/hooks/useEvents", () => ({
  useEvents: () => ({
    subscribe: (listener: (event: JobUpdatedEvent) => void) => {
      eventsListener.current = listener;
      return () => {
        eventsListener.current = null;
      };
    },
  }),
}));

function renderUploadPage() {
  const rootRoute = createRootRoute();
  const uploadRoute = createRoute({ getParentRoute: () => rootRoute, path: "/upload", component: UploadPage });
  const modelRoute = createRoute({ getParentRoute: () => rootRoute, path: "/models/$slug", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([uploadRoute, modelRoute]),
    history: createMemoryHistory({ initialEntries: ["/upload"] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function addFileToQueue(container: HTMLElement, name: string) {
  const input = container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error("file input not found");
  const file = new File([name], name);
  fireEvent.change(input, { target: { files: [file] } });
}

function fakeModel(overrides: Partial<ModelDetail> = {}): ModelDetail {
  return {
    id: 1,
    slug: "my-model",
    name: "My Model",
    description: null,
    source_url: null,
    source_site: null,
    source_author: null,
    source_license: null,
    imported_at: null,
    cover_blob_hash: null,
    is_archived: false,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    tags: [],
    current_revision: {
      id: 10,
      model_id: 1,
      number: 1,
      name: "initial",
      note: null,
      dir_name: "rev-001_initial",
      created_at: "2024-01-01T00:00:00Z",
      files: [],
      notes: [],
    },
    notes: [],
    ...overrides,
  };
}

function fakeUploadResult(jobId: string): UploadResult {
  return { file_id: 1, blob_hash: "abc123", size: 5, job_id: jobId };
}

describe("UploadPage", () => {
  beforeEach(() => {
    createModelMock.mockReset();
    uploadFileMock.mockReset();
    eventsListener.current = null;
  });

  it("reuses the resolved target model for a second upload batch instead of creating a duplicate", async () => {
    createModelMock.mockResolvedValue(fakeModel());
    uploadFileMock.mockResolvedValueOnce(fakeUploadResult("job-1")).mockResolvedValueOnce(fakeUploadResult("job-2"));

    const { container } = renderUploadPage();

    fireEvent.change(await screen.findByLabelText("Model name"), { target: { value: "My Model" } });
    addFileToQueue(container, "a.stl");

    fireEvent.click(screen.getByRole("button", { name: /^Upload/ }));
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));
    expect(createModelMock).toHaveBeenCalledTimes(1);

    // Second batch, still in "new" mode with the same (unedited) name --
    // must reuse the model the first batch created, not call createModel again.
    addFileToQueue(container, "b.stl");
    await waitFor(() => expect(screen.getByRole("button", { name: /^Upload/ })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /^Upload/ }));

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(2));
    expect(createModelMock).toHaveBeenCalledTimes(1);
    expect(uploadFileMock.mock.calls[1][0]).toMatchObject({ modelId: 1, revisionId: 10, relPath: "b.stl" });
  });

  it("creates a new model again after the model name is edited following a completed batch", async () => {
    createModelMock
      .mockResolvedValueOnce(fakeModel({ id: 1, slug: "first-model", name: "First Model" }))
      .mockResolvedValueOnce(fakeModel({ id: 2, slug: "second-model", name: "Second Model" }));
    uploadFileMock.mockResolvedValueOnce(fakeUploadResult("job-1")).mockResolvedValueOnce(fakeUploadResult("job-2"));

    const { container } = renderUploadPage();

    fireEvent.change(await screen.findByLabelText("Model name"), { target: { value: "First Model" } });
    addFileToQueue(container, "a.stl");
    fireEvent.click(screen.getByRole("button", { name: /^Upload/ }));
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));

    // Editing the name after the first batch resolved must clear the cached
    // target so the next upload creates a genuinely new model.
    fireEvent.change(screen.getByLabelText("Model name"), { target: { value: "Second Model" } });
    addFileToQueue(container, "b.stl");
    await waitFor(() => expect(screen.getByRole("button", { name: /^Upload/ })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /^Upload/ }));

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(2));
    expect(createModelMock).toHaveBeenCalledTimes(2);
    expect(uploadFileMock.mock.calls[1][0]).toMatchObject({ modelId: 2 });
  });

  it("uploads to the newly picked existing model after switching targets between batches", async () => {
    uploadFileMock.mockResolvedValueOnce(fakeUploadResult("job-1")).mockResolvedValueOnce(fakeUploadResult("job-2"));

    const { container } = renderUploadPage();

    fireEvent.click(await screen.findByRole("radio", { name: "Existing model" }));

    // Pick Model A from the search results and upload batch 1 to it.
    fireEvent.click(await screen.findByRole("button", { name: "Model A" }));
    await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("Model A"));
    addFileToQueue(container, "a.stl");
    fireEvent.click(screen.getByRole("button", { name: /^Upload/ }));
    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));
    expect(uploadFileMock.mock.calls[0][0]).toMatchObject({ modelId: 1, revisionId: 10 });

    // Switch the picker to Model B without touching the mode radio -- the
    // cached target from batch 1 must be invalidated, or batch 2 silently
    // lands on Model A while the UI claims otherwise.
    fireEvent.click(screen.getByRole("button", { name: "Model B" }));
    await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("Model B"));
    addFileToQueue(container, "b.stl");
    await waitFor(() => expect(screen.getByRole("button", { name: /^Upload/ })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /^Upload/ }));

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(2));
    expect(uploadFileMock.mock.calls[1][0]).toMatchObject({ modelId: 2, revisionId: 20 });
    expect(createModelMock).not.toHaveBeenCalled();
  });

  it("still ends up 'stored' when the terminal SSE event arrives before the upload's PUT response resolves", async () => {
    createModelMock.mockResolvedValue(fakeModel());
    let resolveUpload: (result: UploadResult) => void = () => {};
    uploadFileMock.mockReturnValueOnce(
      new Promise<UploadResult>((resolve) => {
        resolveUpload = resolve;
      }),
    );

    const { container } = renderUploadPage();

    fireEvent.change(await screen.findByLabelText("Model name"), { target: { value: "My Model" } });
    addFileToQueue(container, "a.stl");
    fireEvent.click(screen.getByRole("button", { name: /^Upload/ }));

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(eventsListener.current).not.toBeNull());

    // The job.updated "done" event races ahead of (and arrives before) the
    // PUT response that would otherwise attach `jobId` to this queue item --
    // the fix must still land on "stored" once the response finally resolves.
    eventsListener.current?.({
      type: "job.updated",
      job_id: "job-1",
      job_type: "convert_to_glb",
      state: "done",
      subject_type: "file",
      subject_id: 1,
    });

    resolveUpload(fakeUploadResult("job-1"));

    await waitFor(() => expect(screen.getByText("Stored")).toBeInTheDocument());
  });

  it("evicts a terminal job id from the pending map once it's been applied to its queue item (M2-Minor 5)", async () => {
    // The pending map is a private ref on the component, so this spies on
    // `TerminalEventMap.prototype.delete` -- a dedicated wrapper class kept
    // exactly so tests have a narrow seam to verify eviction through,
    // without hooking the global `Map.prototype` (which React/Radix/
    // TanStack Query also use internally, and did in fact pollute this
    // assertion when tried against the raw `Map`) -- to prove the record
    // doesn't linger for the rest of the tab's life once consumed, instead
    // of growing unbounded across a long session.
    const deleteSpy = vi.spyOn(TerminalEventMap.prototype, "delete");
    createModelMock.mockResolvedValue(fakeModel());
    uploadFileMock.mockResolvedValueOnce(fakeUploadResult("job-1"));

    const { container } = renderUploadPage();

    fireEvent.change(await screen.findByLabelText("Model name"), { target: { value: "My Model" } });
    addFileToQueue(container, "a.stl");
    fireEvent.click(screen.getByRole("button", { name: /^Upload/ }));

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(eventsListener.current).not.toBeNull());

    // By now the upload's PUT response has already resolved and attached
    // `jobId: "job-1"` to the queue item, so this event lands on the direct
    // (already-matched) path -- the record must be evicted right away.
    eventsListener.current?.({
      type: "job.updated",
      job_id: "job-1",
      job_type: "convert_to_glb",
      state: "done",
      subject_type: "file",
      subject_id: 1,
    });

    await waitFor(() => expect(screen.getByText("Stored")).toBeInTheDocument());
    expect(deleteSpy).toHaveBeenCalledWith("job-1");

    deleteSpy.mockRestore();
  });

  it("evicts a terminal job id from the pending map once handleStartUpload consults it after a raced event", async () => {
    createModelMock.mockResolvedValue(fakeModel());
    let resolveUpload: (result: UploadResult) => void = () => {};
    uploadFileMock.mockReturnValueOnce(
      new Promise<UploadResult>((resolve) => {
        resolveUpload = resolve;
      }),
    );

    const { container } = renderUploadPage();

    fireEvent.change(await screen.findByLabelText("Model name"), { target: { value: "My Model" } });
    addFileToQueue(container, "a.stl");
    fireEvent.click(screen.getByRole("button", { name: /^Upload/ }));

    await waitFor(() => expect(uploadFileMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(eventsListener.current).not.toBeNull());

    // The event arrives before the PUT response, so it's held in the
    // pending map (no queue item carries "job-1" yet) rather than evicted
    // immediately.
    eventsListener.current?.({
      type: "job.updated",
      job_id: "job-1",
      job_type: "convert_to_glb",
      state: "done",
      subject_type: "file",
      subject_id: 1,
    });

    const deleteSpy = vi.spyOn(TerminalEventMap.prototype, "delete");
    resolveUpload(fakeUploadResult("job-1"));

    await waitFor(() => expect(screen.getByText("Stored")).toBeInTheDocument());
    expect(deleteSpy).toHaveBeenCalledWith("job-1");

    deleteSpy.mockRestore();
  });
});
