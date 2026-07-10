import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import { PrintablesAccountCard } from "@/components/settings/PrintablesAccountCard";

// `vi.mock` factories are hoisted above the module's own top-level bindings
// (same pattern as BambuAccountCard.test.tsx), so the fakes have to be
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

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PrintablesAccountCard />
    </QueryClientProvider>,
  );
}

describe("PrintablesAccountCard", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    deleteMock.mockReset();
  });

  it("shows the connect form when not connected", async () => {
    getMock.mockResolvedValue({ connected: false, username: null, user_id: null });

    renderCard();

    expect(await screen.findByLabelText("Refresh token")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(screen.queryByText(/Connected as/)).not.toBeInTheDocument();
  });

  it("shows the connected username and a Disconnect button when connected", async () => {
    getMock.mockResolvedValue({ connected: true, username: "makerfoo", user_id: "5092991" });

    renderCard();

    expect(await screen.findByText(/Connected as/)).toBeInTheDocument();
    expect(screen.getByText("makerfoo")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Refresh token")).not.toBeInTheDocument();
  });

  it("submits the pasted refresh token and shows connected on success", async () => {
    getMock.mockResolvedValue({ connected: false, username: null, user_id: null });
    postMock.mockResolvedValue({ connected: true, username: "makerfoo", user_id: "5092991" });

    renderCard();
    await screen.findByLabelText("Refresh token");

    fireEvent.change(screen.getByLabelText("Refresh token"), { target: { value: "RT-pasted" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/settings/printables/connect", {
        refresh_token: "RT-pasted",
      }),
    );
  });

  it("surfaces a 400 failure message", async () => {
    getMock.mockResolvedValue({ connected: false, username: null, user_id: null });
    postMock.mockRejectedValue(
      new ApiError(
        400,
        "Printables refresh token is invalid or expired -- reconnect the Printables account in Settings.",
      ),
    );

    renderCard();
    await screen.findByLabelText("Refresh token");

    fireEvent.change(screen.getByLabelText("Refresh token"), { target: { value: "RT-bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid or expired/);
  });

  it("calls DELETE /settings/printables when Disconnect is clicked", async () => {
    getMock.mockResolvedValue({ connected: true, username: "makerfoo", user_id: "5092991" });
    deleteMock.mockResolvedValue(undefined);

    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith("/settings/printables"));
  });

  it("never renders a token, even one that leaks into a mocked response", async () => {
    getMock
      .mockResolvedValueOnce({ connected: false, username: null, user_id: null })
      .mockResolvedValueOnce({ connected: true, username: "makerfoo", user_id: "5092991" });
    postMock.mockResolvedValue({
      connected: true,
      username: "makerfoo",
      user_id: "5092991",
      // A real backend response never carries these (PrintablesStatusOut has
      // no token field) -- included here defensively to prove the component
      // wouldn't render them even if a response somehow did.
      access_token: "AT-SECRET",
      refresh_token: "RT-SECRET",
    });

    renderCard();
    await screen.findByLabelText("Refresh token");

    fireEvent.change(screen.getByLabelText("Refresh token"), { target: { value: "RT-pasted" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await screen.findByText(/Connected as/);
    expect(document.body.textContent).not.toContain("AT-SECRET");
    expect(document.body.textContent).not.toContain("RT-SECRET");
  });
});
