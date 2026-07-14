import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import { ChangePasswordCard } from "@/components/settings/ChangePasswordCard";

// `vi.mock` factories are hoisted above the module's own top-level bindings
// (same pattern as SiteTokensCard.test.tsx), so the fakes have to be created
// through `vi.hoisted`.
const { postMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
}));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, post: postMock },
  };
});

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ChangePasswordCard />
    </QueryClientProvider>,
  );
}

describe("ChangePasswordCard", () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  it("blocks submit and shows an error when the confirmation doesn't match, without calling the API", () => {
    renderCard();

    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old-pw" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-password-1" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "does-not-match" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    expect(screen.getByText("Passwords don't match.")).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("POSTs current/new password on a matching confirmation and shows a success message", async () => {
    postMock.mockResolvedValue(undefined);

    renderCard();

    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old-pw" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-password-1" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "new-password-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/auth/password", {
        current_password: "old-pw",
        new_password: "new-password-1",
      }),
    );
    expect(await screen.findByText("Password updated.")).toBeInTheDocument();
  });

  it("surfaces the server's 403 detail when the current password is wrong", async () => {
    postMock.mockRejectedValue(new ApiError(403, "Current password is incorrect"));

    renderCard();

    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "wrong-pw" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-password-1" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "new-password-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByText("Current password is incorrect")).toBeInTheDocument();
  });
});
