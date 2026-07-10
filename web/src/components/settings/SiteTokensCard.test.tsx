import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SiteTokensCard } from "@/components/settings/SiteTokensCard";

// `vi.mock` factories are hoisted above the module's own top-level bindings
// (same pattern as PrintablesAccountCard.test.tsx), so the fakes have to be
// created through `vi.hoisted`.
const { getMock, putMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  putMock: vi.fn(),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, get: getMock, put: putMock },
  };
});

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SiteTokensCard />
    </QueryClientProvider>,
  );
}

describe("SiteTokensCard", () => {
  beforeEach(() => {
    getMock.mockReset();
    putMock.mockReset();
  });

  it("shows both token fields, neither pre-filled, when nothing is stored", async () => {
    getMock.mockResolvedValue({ thingiverse_token: "", makerworld_token: "" });

    renderCard();

    expect(await screen.findByLabelText("Thingiverse App Token")).toHaveValue("");
    expect(screen.getByLabelText("MakerWorld web token")).toHaveValue("");
  });

  it("shows the stored placeholder independently per field", async () => {
    getMock.mockResolvedValue({ thingiverse_token: "***", makerworld_token: "" });

    renderCard();

    expect(await screen.findByLabelText("Thingiverse App Token")).toHaveAttribute(
      "placeholder",
      "•• (stored — leave blank to keep)",
    );
    expect(screen.getByLabelText("MakerWorld web token")).toHaveAttribute(
      "placeholder",
      "paste your web token",
    );
  });

  it("submits both fields together through one PUT", async () => {
    getMock.mockResolvedValue({ thingiverse_token: "", makerworld_token: "" });
    putMock.mockResolvedValue({ thingiverse_token: "***", makerworld_token: "***" });

    renderCard();
    await screen.findByLabelText("Thingiverse App Token");

    fireEvent.change(screen.getByLabelText("Thingiverse App Token"), {
      target: { value: "tv-tok" },
    });
    fireEvent.change(screen.getByLabelText("MakerWorld web token"), {
      target: { value: "AACB-mw-tok" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save tokens" }));

    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith("/settings/import-tokens", {
        thingiverse_token: "tv-tok",
        makerworld_token: "AACB-mw-tok",
      }),
    );
  });

  it("clears both inputs after a successful save", async () => {
    getMock.mockResolvedValue({ thingiverse_token: "", makerworld_token: "" });
    putMock.mockResolvedValue({ thingiverse_token: "***", makerworld_token: "***" });

    renderCard();
    await screen.findByLabelText("Thingiverse App Token");

    fireEvent.change(screen.getByLabelText("Thingiverse App Token"), {
      target: { value: "tv-tok" },
    });
    fireEvent.change(screen.getByLabelText("MakerWorld web token"), {
      target: { value: "AACB-mw-tok" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save tokens" }));

    await waitFor(() => expect(screen.getByLabelText("Thingiverse App Token")).toHaveValue(""));
    expect(screen.getByLabelText("MakerWorld web token")).toHaveValue("");
  });

  it("never renders a real token value, even one that leaks into a mocked response", async () => {
    getMock.mockResolvedValue({ thingiverse_token: "", makerworld_token: "" });
    putMock.mockResolvedValue({
      thingiverse_token: "***",
      makerworld_token: "***",
      // A real backend response never carries these (ImportTokensOut has no
      // such fields) -- included defensively to prove the component
      // wouldn't render them even if a response somehow did.
      real_thingiverse_token: "TV-SECRET",
      real_makerworld_token: "AACB-SECRET",
    });

    renderCard();
    await screen.findByLabelText("Thingiverse App Token");

    fireEvent.change(screen.getByLabelText("MakerWorld web token"), {
      target: { value: "AACB-SECRET" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save tokens" }));

    await waitFor(() => expect(screen.getByLabelText("MakerWorld web token")).toHaveValue(""));
    expect(document.body.textContent).not.toContain("TV-SECRET");
    expect(document.body.textContent).not.toContain("AACB-SECRET");
  });
});
