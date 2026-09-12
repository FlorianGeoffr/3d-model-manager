import { useEffect, useRef } from "react";

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // jsdom (tests) doesn't compute `isContentEditable` from the attribute,
  // so check both.
  const editable = target.getAttribute("contenteditable");
  return target.isContentEditable || editable === "" || editable === "true";
}

/** Parses a spec like `"mod+a"` or `"F"` and reports whether `event` matches
 * it. `mod` is Ctrl on Linux/Windows, Meta (Cmd) on macOS. Modifiers not
 * named in the spec (ctrl/meta/alt) must be unpressed, so a bare `"a"`
 * binding doesn't also fire for `mod+a` -- `shift` is the exception, since a
 * bare uppercase letter (e.g. `"F"`) already implies it via `event.key`. */
function matchesSpec(spec: string, event: KeyboardEvent): boolean {
  const parts = spec.split("+");
  const key = parts.pop();
  if (!key) return false;

  let needsCtrl = false;
  let needsMeta = false;
  let needsAlt = false;
  let needsShift = false;
  for (const modifier of parts) {
    if (modifier === "mod") {
      if (isMacPlatform()) needsMeta = true;
      else needsCtrl = true;
    } else if (modifier === "ctrl") needsCtrl = true;
    else if (modifier === "meta") needsMeta = true;
    else if (modifier === "alt") needsAlt = true;
    else if (modifier === "shift") needsShift = true;
    else return false;
  }

  if (event.ctrlKey !== needsCtrl) return false;
  if (event.metaKey !== needsMeta) return false;
  if (event.altKey !== needsAlt) return false;
  if (needsShift && !event.shiftKey) return false;
  return event.key === key;
}

/** Document-level keyboard shortcuts. `bindings` maps a key spec to a
 * handler; the latest `bindings` is read via a ref on every keydown, so
 * callers don't need to memoize it. Repeats are ignored, as are events
 * targeting an input/textarea/select/contenteditable -- except `Escape`,
 * which always fires so it can always back out of something. The matched
 * handler's `event.preventDefault()` is called for it automatically. */
export function useHotkeys(
  bindings: Record<string, (event: KeyboardEvent) => void>,
  opts?: { enabled?: boolean },
) {
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  const enabled = opts?.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.repeat) return;
      if (event.key !== "Escape" && isEditableTarget(event.target)) return;

      for (const [spec, handler] of Object.entries(bindingsRef.current)) {
        if (matchesSpec(spec, event)) {
          event.preventDefault();
          handler(event);
          return;
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [enabled]);
}
