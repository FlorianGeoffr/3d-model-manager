/**
 * Singleton SSE connection for the app (Task 8 decision): one `EventSource`
 * created here, in the authenticated layout (`AppShell`), exposing a
 * `subscribe` API for pages that care about specific jobs (the upload
 * queue), and centrally invalidating model queries whenever a job
 * completes so Files/Revisions tabs pick up newly-stored files without a
 * manual refresh.
 */
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { api } from "@/api/client";
import type { JobUpdatedEvent } from "@/api/types";

type Listener = (event: JobUpdatedEvent) => void;

interface EventsContextValue {
  /** Register a listener for every `job.updated` event; returns an unsubscribe function. */
  subscribe: (listener: Listener) => () => void;
}

const EventsContext = createContext<EventsContextValue | null>(null);

// Minimum time between session probes triggered by `onerror` (below) --
// a real network blip can fire `onerror` repeatedly as the browser retries
// the connection, and there's no reason to hammer `/auth/me` for each one.
const ERROR_PROBE_THROTTLE_MS = 5000;

export function EventsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const listenersRef = useRef(new Set<Listener>());
  const lastErrorProbeRef = useRef(0);

  useEffect(() => {
    const source = new EventSource("/api/events");

    source.onmessage = (event: MessageEvent<string>) => {
      let parsed: JobUpdatedEvent;
      try {
        parsed = JSON.parse(event.data) as JobUpdatedEvent;
      } catch {
        return;
      }
      if (parsed.type !== "job.updated") return;

      if (parsed.state === "done" || parsed.state === "failed") {
        void queryClient.invalidateQueries({ queryKey: ["models"] });
        void queryClient.invalidateQueries({ queryKey: ["revisions"] });
      }

      // The scanner reuses this same `job.updated` shape for its progress
      // (Task 5 brief: "no new SSE event type"), with `job_type:
      // "scan_library"` on every state transition (queued/running/done/
      // failed/skipped) -- refresh the Scan report live for all of them,
      // not just the terminal ones above.
      if (parsed.job_type === "scan_library") {
        void queryClient.invalidateQueries({ queryKey: ["scan"] });
      }

      for (const listener of listenersRef.current) listener(parsed);
    };

    source.onerror = () => {
      // The browser retries a dropped `EventSource` connection forever and
      // silently -- `onerror` carries no status code, so an expired session
      // (the backend 401ing the reconnect) looks identical to a transient
      // network blip. Probing an authenticated endpoint directly is the
      // only way to tell: `api.get`'s 401 handler (client.ts) redirects to
      // /login itself, which is what actually ends the infinite reconnect
      // loop for a real expired session.
      const now = Date.now();
      if (now - lastErrorProbeRef.current < ERROR_PROBE_THROTTLE_MS) return;
      lastErrorProbeRef.current = now;
      void api.get("/auth/me").catch(() => {});
    };

    return () => source.close();
  }, [queryClient]);

  const value = useMemo<EventsContextValue>(
    () => ({
      subscribe: (listener) => {
        listenersRef.current.add(listener);
        return () => {
          listenersRef.current.delete(listener);
        };
      },
    }),
    [],
  );

  return <EventsContext.Provider value={value}>{children}</EventsContext.Provider>;
}

export function useEvents(): EventsContextValue {
  const ctx = useContext(EventsContext);
  if (!ctx) {
    throw new Error("useEvents must be used within an EventsProvider");
  }
  return ctx;
}
