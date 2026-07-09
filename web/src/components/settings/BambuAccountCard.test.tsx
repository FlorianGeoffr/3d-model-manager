import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { BambuAccountCard } from "@/components/settings/BambuAccountCard";

// `vi.mock` factories are hoisted above the module's own top-level bindings
// (same pattern as PrinterSetupCard.test.tsx), so the fakes have to be
// created through `vi.hoisted`.
const { getMock, postMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, get: getMock, post: postMock, delete: deleteMock },
  };
});

// Radix's Select never reaches an interactive open state under jsdom (same
// floating-ui/dismissable-layer limitation noted in SettingsPage.test.tsx) --
// swap it for a plain native <select> driven by change events.
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

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BambuAccountCard />
    </QueryClientProvider>,
  );
}

describe("BambuAccountCard", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    deleteMock.mockReset();
  });

  it("shows the login form when not connected", async () => {
    getMock.mockResolvedValue({ connected: false, account: null, region: "global" });

    renderCard();

    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(screen.queryByText(/Connected as/)).not.toBeInTheDocument();
  });

  it("shows the connected account and a Disconnect button when connected", async () => {
    getMock.mockResolvedValue({ connected: true, account: "a@b.com", region: "global" });

    renderCard();

    expect(await screen.findByText(/Connected as/)).toBeInTheDocument();
    expect(screen.getByText("a@b.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("reveals a verification-code input on mfa_required, then echoes mfa_context back on verify", async () => {
    getMock.mockResolvedValue({ connected: false, account: null, region: "global" });
    postMock.mockImplementation((path: string) => {
      if (path === "/settings/bambu/login") {
        return Promise.resolve({
          status: "mfa_required",
          account: "a@b.com",
          region: "global",
          mfa_context: { tfaKey: "ctx-1" },
        });
      }
      if (path === "/settings/bambu/verify") {
        return Promise.resolve({ status: "connected", account: "a@b.com", region: "global", mfa_context: null });
      }
      return Promise.reject(new Error(`unexpected POST ${path}`));
    });

    renderCard();
    await screen.findByLabelText("Email");

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/settings/bambu/login", {
        account: "a@b.com",
        password: "hunter2",
        region: "global",
      }),
    );

    expect(await screen.findByLabelText("Verification code")).toBeInTheDocument();
    // The password field and plain Connect button drop away once the MFA
    // step is showing -- the operator only has code entry / Verify left.
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/settings/bambu/verify", {
        account: "a@b.com",
        code: "000000",
        region: "global",
        mfa_context: { tfaKey: "ctx-1" },
      }),
    );
  });

  it("calls DELETE /settings/bambu when Disconnect is clicked", async () => {
    getMock.mockResolvedValue({ connected: true, account: "a@b.com", region: "global" });
    deleteMock.mockResolvedValue(undefined);

    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("/settings/bambu"));
  });

  it("never renders a token, even one that leaks into a mocked response", async () => {
    getMock
      .mockResolvedValueOnce({ connected: false, account: null, region: "global" })
      .mockResolvedValueOnce({ connected: true, account: "a@b.com", region: "global" });
    postMock.mockResolvedValue({
      status: "connected",
      account: "a@b.com",
      region: "global",
      mfa_context: null,
      // A real backend response never carries these (BambuLoginOut has no
      // token field) -- included here defensively to prove the component
      // wouldn't render them even if a response somehow did.
      access_token: "AT-SECRET",
      refresh_token: "RT-SECRET",
    });

    renderCard();
    await screen.findByLabelText("Email");

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await screen.findByText(/Connected as/);
    expect(document.body.textContent).not.toContain("AT-SECRET");
    expect(document.body.textContent).not.toContain("RT-SECRET");
  });
});
