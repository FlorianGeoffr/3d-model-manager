import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import type { JobOut } from "@/api/types";
import { JobsPage } from "@/pages/JobsPage";

// `vi.mock` factories are hoisted above the module's own top-level bindings
// (same pattern as SettingsPage.test.tsx), so the fakes have to be created
// through `vi.hoisted`.
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

// Radix's Select never reaches an interactive open state under jsdom (same
// floating-ui/dismissable-layer limitation noted in SettingsPage.test.tsx/
// UploadPage.test.tsx) -- swap it for a plain native <select>.
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
    <select aria-label="Filter by state" value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

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
    error: "conversion crashed",
    created_at: "2026-07-05T00:00:00Z",
    updated_at: "2026-07-05T00:00:00Z",
    ...overrides,
  };
}

function renderJobsPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <JobsPage />
    </QueryClientProvider>,
  );
}

describe("JobsPage", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it("retries a failed job and refetches the list", async () => {
    const job = fakeJob({ id: "job-1", state: "failed" });
    getMock.mockResolvedValue([job]);
    postMock.mockResolvedValue({ ...job, state: "queued", error: null });

    renderJobsPage();

    const retryButton = await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(retryButton);

    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/jobs/job-1/retry"));
    // Success invalidates ["jobs"], which triggers a refetch -- the initial
    // load plus that refetch is the observable "the list re-rendered live".
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2));
  });

  it("hides the Retry control for a migrate_storage job (it hard-409s on retry)", async () => {
    const job = fakeJob({ id: "job-2", type: "migrate_storage", state: "failed", subject_type: null, subject_id: null });
    getMock.mockResolvedValue([job]);

    renderJobsPage();

    await screen.findByText("migrate_storage");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByText("Re-run from Settings")).toBeInTheDocument();
  });

  it("shows a dead-lettered badge for a dead job", async () => {
    const job = fakeJob({ id: "job-3", state: "dead", attempts: 3, max_attempts: 3 });
    getMock.mockResolvedValue([job]);

    renderJobsPage();

    // Wait for the row to actually load first -- the filter dropdown's own
    // "Dead-lettered" option label is present from the very first render
    // (independent of the query), so a bare `findByText("Dead-lettered")`
    // would resolve against that instead of the table's badge.
    await screen.findByRole("button", { name: "Retry" });
    // A dead job is still retryable (Task 8: the "operator fixed it, retry
    // anyway" escape hatch) -- the badge doesn't hide the button. The badge
    // renders as a `<span>` (`components/ui/badge.tsx`), distinguishing it
    // from the dropdown's `<option>` of the same text.
    expect(screen.getByText("Dead-lettered", { selector: "span" })).toBeInTheDocument();
  });

  it("surfaces the retry mutation's 409 detail inline", async () => {
    const { ApiError } = await import("@/api/client");
    const job = fakeJob({ id: "job-4", state: "failed" });
    getMock.mockResolvedValue([job]);
    postMock.mockRejectedValue(new ApiError(409, "subject file no longer exists"));

    renderJobsPage();

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("subject file no longer exists");
  });

  it("shows empty-state copy when no jobs need attention", async () => {
    getMock.mockResolvedValue([]);

    renderJobsPage();

    expect(await screen.findByText("No jobs need attention.")).toBeInTheDocument();
  });

  it("switches to the full list and clears the filter-specific empty copy when 'All' is selected", async () => {
    getMock.mockResolvedValue([]);

    renderJobsPage();
    await screen.findByText("No jobs need attention.");

    fireEvent.change(screen.getByLabelText("Filter by state"), { target: { value: "all" } });

    expect(await screen.findByText("No jobs match this filter.")).toBeInTheDocument();
  });
});
