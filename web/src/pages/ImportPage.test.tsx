import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ImportPage } from "@/pages/ImportPage";

// `vi.mock` factories are hoisted above the module's own top-level bindings
// (same pattern as PrinterSetupCard.test.tsx), so the fakes have to be
// created through `vi.hoisted`.
const { postMock } = vi.hoisted(() => ({ postMock: vi.fn() }));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, post: postMock },
  };
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ImportPage />
    </QueryClientProvider>,
  );
}

describe("ImportPage", () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it("shows the friendly not-available message and disables Import for a MakerWorld URL", () => {
    renderPage();

    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://makerworld.com/en/models/1" },
    });

    expect(screen.getByText(/MakerWorld import isn't available yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("enables Import for a supported Printables URL", () => {
    renderPage();

    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "https://www.printables.com/model/3161-benchy" },
    });

    expect(screen.getByText("Printables")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
  });
});
