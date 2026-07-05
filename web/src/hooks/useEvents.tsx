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

import type { JobUpdatedEvent } from "@/api/types";

type Listener = (event: JobUpdatedEvent) => void;

interface EventsContextValue {
  /** Register a listener for every `job.updated` event; returns an unsubscribe function. */
  subscribe: (listener: Listener) => () => void;
}

const EventsContext = createContext<EventsContextValue | null>(null);

export function EventsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const listenersRef = useRef(new Set<Listener>());

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

      for (const listener of listenersRef.current) listener(parsed);
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
