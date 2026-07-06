import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventsProvider } from "@/hooks/useEvents";

// `vi.mock` factories are hoisted above the module's own top-level bindings
// (same pattern as LibraryPage.test.tsx), so the fake has to be created
// through `vi.hoisted`.
const { getMock } = vi.hoisted(() => ({ getMock: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: { ...actual.api, get: getMock },
  };
});

// jsdom has no `EventSource` implementation -- this stub captures just
// enough of the interface (the `onerror` handler `EventsProvider` assigns)
// for the test to trigger it directly, without a real SSE connection.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close() {}
}

function renderProvider() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <EventsProvider>
        <div>ready</div>
      </EventsProvider>
    </QueryClientProvider>,
  );
}

describe("EventsProvider onerror session probe", () => {
  beforeEach(() => {
    getMock.mockClear();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("probes /auth/me on a connection error, throttled to at most once per 5s", () => {
    renderProvider();
    const source = FakeEventSource.instances[0];
    expect(source).toBeDefined();

    // Repeated `onerror` firings within the throttle window (e.g. the
    // browser's own reconnect retries during a network blip) must not
    // each trigger a probe.
    source.onerror?.();
    source.onerror?.();
    source.onerror?.();
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith("/auth/me");

    vi.advanceTimersByTime(5000);
    source.onerror?.();
    expect(getMock).toHaveBeenCalledTimes(2);
  });
});
