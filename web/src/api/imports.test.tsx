import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import type { ImportOut } from "@/api/types";
import { useFailedImportsCount, useImportsList, useRetryImport } from "@/api/imports";

// `vi.mock` factories are hoisted above the module's own top-level bindings
// (same pattern as jobs.test.tsx), so the fakes have to be created through
// `vi.hoisted`.
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

function fakeImport(overrides: Partial<ImportOut> = {}): ImportOut {
  return {
    id: 1,
    url: "https://makerworld.com/en/models/1",
    site: "makerworld",
    external_id: "1",
    state: "done",
    model_id: 5,
    error: null,
    meta: null,
    created_at: "2026-07-11T00:00:00Z",
    updated_at: "2026-07-11T00:00:00Z",
    ...overrides,
  };
}

function wrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useImportsList", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it("fetches GET /imports?limit=50", async () => {
    getMock.mockResolvedValue([fakeImport()]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useImportsList(), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMock).toHaveBeenCalledWith("/imports?limit=50");
    expect(result.current.data).toEqual([fakeImport()]);
  });
});

describe("useFailedImportsCount", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it("counts only failed rows from the shared imports list", async () => {
    getMock.mockResolvedValue([
      fakeImport({ id: 1, state: "done" }),
      fakeImport({ id: 2, state: "failed" }),
      fakeImport({ id: 3, state: "failed" }),
      fakeImport({ id: 4, state: "pending" }),
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useFailedImportsCount(), { wrapper: wrapper(queryClient) });

    await waitFor(() => expect(result.current).toBe(2));
  });

  it("reports 0 before the query has resolved", () => {
    getMock.mockReturnValue(new Promise(() => {})); // never resolves
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useFailedImportsCount(), { wrapper: wrapper(queryClient) });

    expect(result.current).toBe(0);
  });
});

describe("useRetryImport", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it("posts to /imports/{id}/retry and invalidates imports + models on success", async () => {
    postMock.mockResolvedValue(fakeImport({ id: 7, state: "pending" }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useRetryImport(), { wrapper: wrapper(queryClient) });

    result.current.mutate(7);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(postMock).toHaveBeenCalledWith("/imports/7/retry");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["imports"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["models"] });
  });

  it("surfaces the backend's 409 detail as an ApiError on failure", async () => {
    const { ApiError } = await import("@/api/client");
    postMock.mockRejectedValue(new ApiError(409, "import 7 is not failed"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useRetryImport(), { wrapper: wrapper(queryClient) });

    result.current.mutate(7);

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as InstanceType<typeof ApiError>).detail).toBe("import 7 is not failed");
  });
});
