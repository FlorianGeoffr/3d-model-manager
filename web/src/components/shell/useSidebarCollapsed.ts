import { useEffect, useState } from "react";

import { useHotkeys } from "@/hooks/useHotkeys";

const STORAGE_KEY = "tdmm.sidebarCollapsed";

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Persists the sidebar's collapsed/icon-rail state across reloads and wires
 * Ctrl/Cmd+B to toggle it (same `mod+` convention as the rest of the app's
 * hotkeys -- see `useHotkeys`). */
export function useSidebarCollapsed(): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const [collapsed, setCollapsedState] = useState(readStored);

  function setCollapsed(next: boolean | ((prev: boolean) => boolean)) {
    setCollapsedState((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      try {
        window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
      } catch {
        // Best-effort persistence only -- a private window or blocked
        // storage just means the state doesn't survive a reload.
      }
      return value;
    });
  }

  useHotkeys({ "mod+b": () => setCollapsed((prev) => !prev) });

  // Reflects other tabs toggling the same key (not required, but cheap).
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === STORAGE_KEY) setCollapsedState(event.newValue === "1");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return [collapsed, setCollapsed];
}
