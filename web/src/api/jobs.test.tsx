import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import type { JobOut } from "@/api/types";
import { useJobs, useRetryJob } from "@/api/jobs";

// `vi.mock` factories are hoisted above the module's own top-level bindings
// (same pattern as LibraryPage.test.tsx/SettingsPage.test.tsx), so the
// fakes have to be created through `vi.hoisted`.
const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, get: getMock, post: postMock },
  };
});

function fakeJob(overrides: Partial<JobOut> = {}): JobOut {
  return {
    id: "job-1",
    celery_id: "job-1",
    type: "convert_to_glb",
    subject_type: "file",
    subject_id: 1,
    state: "failed",
    attempts: 1,
    max_attempts: 3,
    error: "boom",
    created_at: "2026-07-05T00:00:00Z",
    updated_at: "2026-07-05T00:00:00Z",
    ...overrides,
  };
}

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useJobs", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it("fetches the unfiltered list when no state is given", async () => {
    getMock.mockResolvedValue([fakeJob()]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useJobs(), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith("/jobs");
  });

  it("passes ?state= through to the request when a state filter is given", async () => {
    getMock.mockResolvedValue([fakeJob({ state: "failed" })]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useJobs({ state: "failed" }), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith("/jobs?state=failed");
  });
});

describe("useRetryJob", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it("posts to /jobs/{id}/retry and invalidates the jobs query on success", async () => {
    postMock.mockResolvedValue(fakeJob({ state: "queued" }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useRetryJob(), { wrapper: wrapper(queryClient) });

    result.current.mutate("job-1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith("/jobs/job-1/retry");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["jobs"] });
  });

  it("surfaces the backend's 409 detail as an ApiError on failure", async () => {
    const { ApiError } = await import("@/api/client");
    postMock.mockRejectedValue(new ApiError(409, "migrations are re-run from Settings, not retried"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useRetryJob(), { wrapper: wrapper(queryClient) });

    result.current.mutate("job-2");

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as InstanceType<typeof ApiError>).detail).toBe(
      "migrations are re-run from Settings, not retried",
    );
  });
});
