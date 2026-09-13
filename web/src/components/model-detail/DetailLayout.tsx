import type { ReactNode } from "react";

/** GyroidVault-style detail page shell (R13a): an elastic left studio column
 * plus a fixed 508px right column of stacked cards, replacing the old
 * 5-tab `SidePanel`. Single column below 900px (grid's default), left
 * content first -- same stacking order the wireframe calls for on mobile.
 * Not sticky: with a full stack of right-column cards there's no single
 * "shorter" side to pin without fighting the page's own scroll. */
export function DetailLayout({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-6 min-[900px]:grid-cols-[minmax(0,1fr)_508px]">
      <div className="flex min-w-0 flex-col gap-6">{left}</div>
      <div className="flex min-w-0 flex-col gap-6">{right}</div>
    </div>
  );
}
