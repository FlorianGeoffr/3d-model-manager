import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { ApiError } from "@/api/client";
import type { JobOut, StorageBackendOut, StorageConfigOut } from "@/api/types";
import { SettingsPage } from "@/pages/SettingsPage";

// `vi.mock` factories are hoisted above the module's own top-level bindings
// (same pattern as LibraryPage.test.tsx/UploadPage.test.tsx), so the fakes
// have to be created through `vi.hoisted`.
const { getMock, postMock, putMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  putMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, get: getMock, post: postMock, put: putMock, delete: deleteMock },
  };
});

// Radix's Select never reaches an interactive open state under jsdom (same
// floating-ui/dismissable-layer limitation noted in UploadPage.test.tsx and
// already worked around identically in ViewerTab.test.tsx) -- swap it for a
// plain native <select> driven by change events. Forwards `...rest` (unlike
// the single-Select-per-page assumption this mock started with) so the
// backends-list tests below -- which can have more than one Select live at
// once (the legacy card's backend picker plus an open Add/Edit dialog's own
// one) -- can still tell them apart or simply scope queries with `within`.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
    ...rest
  }: {
    value?: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
    children?: ReactNode;
  } & Record<string, unknown>) => (
    <select value={value} disabled={disabled} onChange={(event) => onValueChange(event.target.value)} {...rest}>
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

// Radix Tabs switches on focus/pointer, not a bare `fireEvent.click`, so tab
// activation is unreliable under jsdom (same class of limitation as the Select
// mock above). Swap it for a minimal stateful mock that renders only the
// active panel (so cards on different tabs don't collide, e.g. the SMB
// password field vs. the Bambu login password) and switches on a click.
vi.mock("@/components/ui/tabs", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const TabsCtx = React.createContext<{ value: string; setValue: (value: string) => void }>({
    value: "",
    setValue: () => {},
  });
  return {
    Tabs: ({ defaultValue, children }: { defaultValue?: string; children?: ReactNode }) => {
      const [value, setValue] = React.useState(defaultValue ?? "");
      return <TabsCtx.Provider value={{ value, setValue }}>{children}</TabsCtx.Provider>;
    },
    TabsList: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    TabsTrigger: ({ value, children }: { value: string; children?: ReactNode }) => {
      const ctx = React.useContext(TabsCtx);
      return (
        <button role="tab" type="button" onClick={() => ctx.setValue(value)}>
          {children}
        </button>
      );
    },
    TabsContent: ({ value, children }: { value: string; children?: ReactNode }) => {
      const ctx = React.useContext(TabsCtx);
      return ctx.value === value ? <div>{children}</div> : null;
    },
  };
});

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
    max_attempts: 3,
    error: null,
    created_at: "2026-07-05T00:00:00Z",
    updated_at: "2026-07-05T00:00:00Z",
    ...overrides,
  };
}

function fakeBackend(overrides: Partial<StorageBackendOut> = {}): StorageBackendOut {
  return {
    id: 1,
    name: "Default",
    scheme: "local",
    is_default: true,
    config: { backend: "local", root: "" },
    created_at: "2026-07-05T00:00:00Z",
    ...overrides,
  };
}

function mockGet(storage: StorageConfigOut, jobs: JobOut[] = [], backends: StorageBackendOut[] = []) {
  getMock.mockImplementation((path: string) => {
    if (path === "/settings/storage") return Promise.resolve(storage);
    if (path === "/settings/storage/backends") return Promise.resolve(backends);
    if (path.startsWith("/jobs")) return Promise.resolve(jobs);
    // BambuAccountCard's status query -- not under test here, just needs a
    // well-shaped response so the card renders its not-connected form
    // instead of dangling on an indefinite/garbage response.
    if (path === "/settings/bambu") return Promise.resolve({ connected: false, account: null, region: "global" });
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
    deleteMock.mockReset();
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

  it("renders the Bambu account card in the Imports tab", async () => {
    mockGet(localConfig());

    renderSettingsPage();

    fireEvent.click(await screen.findByRole("tab", { name: "Imports" }));

    expect(await screen.findByText("Bambu Lab account")).toBeInTheDocument();
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Storage backends list (Workstream C task C4): the `StorageBackendsCard`
// evolving the single-backend `StorageSettingsCard` above it into a list of
// every configured `storage_backends` row.
// ---------------------------------------------------------------------------

describe("SettingsPage -- storage backends list", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    putMock.mockReset();
    deleteMock.mockReset();
  });

  it("renders every configured backend with a Default badge on the write target", async () => {
    mockGet(localConfig(), [], [
      fakeBackend({ id: 1, name: "Primary NAS", is_default: true }),
      fakeBackend({ id: 2, name: "Cold storage", scheme: "s3", is_default: false }),
    ]);

    renderSettingsPage();

    expect(await screen.findByText("Primary NAS")).toBeInTheDocument();
    expect(screen.getByText("Cold storage")).toBeInTheDocument();
    // "Default" also names the table column header -- scope to the row.
    const primaryRow = screen.getByText("Primary NAS").closest("tr");
    if (!primaryRow) throw new Error("primary row not found");
    expect(within(primaryRow).getByText("Default")).toBeInTheDocument();
  });

  it("adds a new storage backend through the Add backend dialog", async () => {
    mockGet(localConfig(), [], [fakeBackend({ id: 1, name: "Primary", is_default: true })]);
    postMock.mockImplementation((path: string) => {
      if (path === "/settings/storage/backends") {
        return Promise.resolve(fakeBackend({ id: 2, name: "Backup", is_default: false }));
      }
      return Promise.resolve({});
    });

    renderSettingsPage();
    await screen.findByText("Primary");

    fireEvent.click(screen.getByRole("button", { name: "Add backend" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Backup" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add backend" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/settings/storage/backends", {
        name: "Backup",
        config: { backend: "local" },
      }),
    );
  });

  it("sets a non-default backend as the new default", async () => {
    mockGet(localConfig(), [], [
      fakeBackend({ id: 1, name: "Primary", is_default: true }),
      fakeBackend({ id: 2, name: "Backup", is_default: false }),
    ]);
    postMock.mockResolvedValue(fakeBackend({ id: 2, name: "Backup", is_default: true }));

    renderSettingsPage();
    await screen.findByText("Backup");

    const backupRow = screen.getByText("Backup").closest("tr");
    if (!backupRow) throw new Error("backup row not found");
    fireEvent.click(within(backupRow).getByRole("button", { name: "Set default" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/settings/storage/backends/2/default"));
  });

  it("surfaces the backend's 409 guardrail error when a delete is rejected", async () => {
    mockGet(localConfig(), [], [
      fakeBackend({ id: 1, name: "Primary", is_default: true }),
      fakeBackend({ id: 2, name: "Backup", is_default: false }),
    ]);
    deleteMock.mockRejectedValue(
      new ApiError(409, "storage backend 2 still holds 3 file(s); relocate them first"),
    );

    renderSettingsPage();
    await screen.findByText("Backup");

    const backupRow = screen.getByText("Backup").closest("tr");
    if (!backupRow) throw new Error("backup row not found");
    fireEvent.click(within(backupRow).getByRole("button", { name: "Delete" }));

    // The row's own trigger and the confirm dialog's action button share the
    // label "Delete" -- scope to the (portal-rendered) dialog to disambiguate.
    const confirmDialog = await screen.findByRole("dialog");
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText(/still holds 3 file\(s\); relocate them first/)).toBeInTheDocument();
  });
});
