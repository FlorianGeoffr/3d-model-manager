import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { ImportPage } from "@/pages/ImportPage";

// `vi.mock` factories are hoisted above the module's own top-level bindings
// (same pattern as PrinterSetupCard.test.tsx), so the fakes have to be
// created through `vi.hoisted`.
const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, get: getMock, post: postMock },
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

// ImportPage now renders a `<Link to="/settings">` (the MakerWorld caveat
// note in the Search tab) alongside its own `<Link to="/">` (import-done
// "View library"), so it needs a real router context -- mirrors
// ModelCard.test.tsx's minimal-route-tree + memory-history setup rather than
// a raw QueryClientProvider-only render.
function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const importRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: ImportPage });
  const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([importRoute, settingsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("ImportPage", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    getMock.mockResolvedValue([]);
  });

  it("enables Import for a supported Printables URL", async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText("URL"), {
      target: { value: "https://www.printables.com/model/3161-benchy" },
    });

    expect(screen.getByText("Printables")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
  });

  it("enables Import for a MakerWorld URL now that it's supported", async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText("URL"), {
      target: { value: "https://makerworld.com/en/models/1" },
    });

    expect(screen.getByText("MakerWorld")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeEnabled();
    expect(screen.queryByText(/isn't available yet/)).not.toBeInTheDocument();
  });

  it("still rejects an unrecognized URL", async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText("URL"), { target: { value: "https://example.com/x" } });

    expect(screen.getByText(/Unrecognized link/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  });

  describe("Search tab", () => {
    it("prompts to type before any query is entered", async () => {
      renderPage();

      fireEvent.mouseDown(await screen.findByRole("tab", { name: "Search" }));

      expect(screen.getByText("Type to search.")).toBeInTheDocument();
      expect(getMock).not.toHaveBeenCalled();
    });

    it("renders results for a typed query and starts an import when 'Add to library' is clicked", async () => {
      getMock.mockImplementation((path: string) => {
        if (path.startsWith("/imports/search")) {
          return Promise.resolve([
            {
              site: "thingiverse",
              external_id: "763622",
              title: "Cool Vase",
              url: "https://www.thingiverse.com/thing:763622",
              author: "jane",
              thumbnail_url: null,
            },
          ]);
        }
        return Promise.resolve([]);
      });
      postMock.mockResolvedValue({
        id: 42,
        url: "https://www.thingiverse.com/thing:763622",
        site: "thingiverse",
        external_id: "763622",
        state: "pending",
        model_id: null,
        error: null,
        meta: null,
        created_at: "2026-07-08T00:00:00Z",
        updated_at: "2026-07-08T00:00:00Z",
      });

      renderPage();
      fireEvent.mouseDown(await screen.findByRole("tab", { name: "Search" }));
      fireEvent.change(screen.getByLabelText("Search query"), { target: { value: "vase" } });

      expect(await screen.findByText("Cool Vase")).toBeInTheDocument();
      expect(screen.getByText(/by jane/)).toBeInTheDocument();
      await waitFor(() =>
        expect(getMock).toHaveBeenCalledWith(
          expect.stringContaining("/imports/search?site=thingiverse&q=vase"),
        ),
      );

      fireEvent.click(screen.getByRole("button", { name: "Add to library" }));

      await waitFor(() =>
        expect(postMock).toHaveBeenCalledWith("/imports", { url: "https://www.thingiverse.com/thing:763622" }),
      );
    });

    it("shows the MakerWorld caveat note when MakerWorld is the selected site", async () => {
      const { container } = renderPage();
      fireEvent.mouseDown(await screen.findByRole("tab", { name: "Search" }));

      expect(screen.queryByText(/connected Bambu account/)).not.toBeInTheDocument();

      // The mocked Select (see above) doesn't carry the `id` given to
      // `SelectTrigger` through to the native `<select>` it renders, so
      // there's nothing for `getByLabelText` to associate with the "Site"
      // label -- select it directly, same as SettingsPage.test.tsx does for
      // its backend picker.
      const siteSelect = container.querySelector("select");
      if (!(siteSelect instanceof HTMLSelectElement)) throw new Error("site select not found");
      fireEvent.change(siteSelect, { target: { value: "makerworld" } });

      expect(screen.getByText(/connected Bambu account/)).toBeInTheDocument();
    });
  });
});
