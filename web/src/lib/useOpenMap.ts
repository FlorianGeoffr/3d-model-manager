import { useCallback, useState } from "react";

/**
 * Tracks open/closed state for a set of collapsible sections, keyed by id.
 *
 * The backing state only records *explicit* overrides made through
 * `toggle`/`openAll`/`closeAll`; an id with no explicit entry falls back to
 * `defaultOpen` (a fixed boolean, or a per-id predicate). This means
 * `openAll`/`closeAll` never "poison" ids outside the current set -- an id
 * that shows up later (e.g. after a filter changes) still resolves to its
 * own default until something explicitly toggles it.
 */
export function useOpenMap<Id extends string | number>(
  ids: readonly Id[],
  defaultOpen: boolean | ((id: Id) => boolean),
): {
  isOpen: (id: Id) => boolean;
  toggle: (id: Id) => void;
  openAll: () => void;
  closeAll: () => void;
  allOpen: boolean;
  allClosed: boolean;
} {
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});

  const resolveDefault = useCallback(
    (id: Id): boolean => (typeof defaultOpen === "function" ? defaultOpen(id) : defaultOpen),
    [defaultOpen],
  );

  const isOpen = useCallback(
    (id: Id): boolean => {
      const key = String(id);
      return key in openMap ? openMap[key] : resolveDefault(id);
    },
    [openMap, resolveDefault],
  );

  const toggle = useCallback(
    (id: Id) => {
      setOpenMap((prev) => ({ ...prev, [String(id)]: !isOpen(id) }));
    },
    [isOpen],
  );

  const openAll = useCallback(() => {
    setOpenMap((prev) => {
      const next = { ...prev };
      for (const id of ids) next[String(id)] = true;
      return next;
    });
  }, [ids]);

  const closeAll = useCallback(() => {
    setOpenMap((prev) => {
      const next = { ...prev };
      for (const id of ids) next[String(id)] = false;
      return next;
    });
  }, [ids]);

  const allOpen = ids.length > 0 && ids.every((id) => isOpen(id));
  const allClosed = ids.length > 0 && ids.every((id) => !isOpen(id));

  return { isOpen, toggle, openAll, closeAll, allOpen, allClosed };
}
