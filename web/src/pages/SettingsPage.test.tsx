import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import type { JobOut, StorageConfigOut } from "@/api/types";
import { SettingsPage } from "@/pages/SettingsPage";

// `vi.mock` factories are hoisted above the module's own top-level bindings
// (same pattern as LibraryPage.test.tsx/UploadPage.test.tsx), so the fakes
// have to be created through `vi.hoisted`.
const { getMock, postMock, putMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  putMock: vi.fn(),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, get: getMock, post: postMock, put: putMock },
  };
});

// Radix's Select never reaches an interactive open state under jsdom (same
// floating-ui/dismissable-layer limitation noted in UploadPage.test.tsx and
// already worked around identically in ViewerTab.test.tsx) -- swap it for a
// plain native <select> driven by change events.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value?: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
    children?: ReactNode;
  }) => (
    <select value={value} disabled={disabled} onChange={(event) => onValueChange(event.target.value)}>
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

function localConfig(): StorageConfigOut {
  return { backend: "local", config: { backend: "local" } };
}

function smbConfigWithStoredSecret(): StorageConfigOut {
  return {
    backend: "smb",
    config: {
      backend: "smb",
      host: "nas.local",
      share: "models",
      root: "",
      username: "admin",
      password: "***",
      port: 445,
      encrypt: true,
    },
  };
}

function fakeJob(overrides: Partial<JobOut> = {}): JobOut {
  return {
    id: "job-1",
    celery_id: "job-1",
    type: "migrate_storage",
    subject_type: null,
    subject_id: null,
    state: "queued",
    attempts: 0,
    error: null,
    created_at: "2026-07-05T00:00:00Z",
    updated_at: "2026-07-05T00:00:00Z",
    ...overrides,
  };
}

function mockGet(storage: StorageConfigOut, jobs: JobOut[] = []) {
  getMock.mockImplementation((path: string) => {
    if (path === "/settings/storage") return Promise.resolve(storage);
    if (path.startsWith("/jobs")) return Promise.resolve(jobs);
    return Promise.resolve([]);
  });
}

function renderSettingsPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

describe("SettingsPage", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    putMock.mockReset();
  });

  it("shows the currently active backend and no per-backend fields for local", async () => {
    mockGet(localConfig());

    renderSettingsPage();

    expect(await screen.findByText("local")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Host/)).not.toBeInTheDocument();
  });

  it("swaps the visible fields when the backend selection changes", async () => {
    mockGet(localConfig());

    const { container } = renderSettingsPage();
    await screen.findByText("Storage backend");
    const backendSelect = container.querySelector("select");
    if (!(backendSelect instanceof HTMLSelectElement)) throw new Error("backend select not found");

    fireEvent.change(backendSelect, { target: { value: "smb" } });
    expect(await screen.findByLabelText(/Host/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Bucket/)).not.toBeInTheDocument();

    fireEvent.change(backendSelect, { target: { value: "s3" } });
    expect(await screen.findByLabelText(/Bucket/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Host/)).not.toBeInTheDocument();
  });

  it("tests the current candidate config and renders a success result", async () => {
    mockGet(localConfig());
    postMock.mockResolvedValue({ ok: true, detail: "wrote+read+deleted a probe file", latency_ms: 12 });

    renderSettingsPage();
    await screen.findByText("Storage backend");

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    expect(await screen.findByText(/wrote\+read\+deleted a probe file/)).toBeInTheDocument();
    expect(postMock).toHaveBeenCalledWith("/settings/storage/test", {
      backend: "local",
      config: { backend: "local" },
    });
  });

  it("renders a failed test result as a destructive alert", async () => {
    mockGet(localConfig());
    postMock.mockResolvedValue({ ok: false, detail: "connection refused", latency_ms: 3 });

    renderSettingsPage();
    await screen.findByText("Storage backend");

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("connection refused");
  });

  it("leaves a blank secret field out of the request so the stored one is kept", async () => {
    mockGet(smbConfigWithStoredSecret());
    postMock.mockResolvedValue({ ok: true, detail: "ok", latency_ms: 5 });

    renderSettingsPage();
    await screen.findByLabelText(/Host/);

    // The GET-redacted "***" must never end up as the input's actual value.
    expect(screen.getByLabelText(/Password/)).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const [, body] = postMock.mock.calls[0] as [string, { config: Record<string, unknown> }];
    expect(body.config).not.toHaveProperty("password");
    expect(body.config.host).toBe("nas.local");
  });

  it("sends a secret field once the user types a new value", async () => {
    mockGet(smbConfigWithStoredSecret());
    postMock.mockResolvedValue({ ok: true, detail: "ok", latency_ms: 5 });

    renderSettingsPage();
    await screen.findByLabelText(/Host/);

    fireEvent.change(screen.getByLabelText(/Password/), { target: { value: "new-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() => expect(postMock).toHaveBeenCalled());
    const [, body] = postMock.mock.calls[0] as [string, { config: Record<string, unknown> }];
    expect(body.config.password).toBe("new-secret");
  });

  it("gates migration behind a confirm dialog and shows progress via job polling", async () => {
    mockGet(localConfig(), [fakeJob({ state: "running" })]);
    postMock.mockResolvedValue(fakeJob({ state: "queued" }));

    renderSettingsPage();
    await screen.findByText("Storage backend");

    fireEvent.click(screen.getByRole("button", { name: "Migrate library to this backend" }));
    expect(postMock).not.toHaveBeenCalled();

    const confirmButton = await screen.findByRole("button", { name: "Migrate" });
    fireEvent.click(confirmButton);

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/settings/storage/migrate", {
        backend: "local",
        config: { backend: "local" },
      }),
    );
    expect(await screen.findByText(/Migration running/)).toBeInTheDocument();
  });
});
