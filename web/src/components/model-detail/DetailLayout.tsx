import type { ReactNode } from "react";

/** GyroidVault-style detail page shell (R13a): an elastic left studio column
 * plus a fixed 508px right column of stacked cards, replacing the old
 * 5-tab `SidePanel`. Single column below 900px (grid's default), left
 * content first -- same stacking order the wireframe calls for on mobile.
 * Not sticky: with a full stack of right-column cards there's no single
 * "shorter" side to pin without fighting the page's own scroll.
 *
 * `items-start`: CSS Grid stretches row items to match the tallest one by
 * default, which stretched the left column to the right column's (much
 * taller) full height -- any `flex-1` child of the left column (the studio
 * surface) then grew to fill that borrowed height, leaving a wall of blank
 * space below the viewer instead of the Description card starting right
 * under it. `items-start` keeps each column at its own natural content
 * height instead. */
export function DetailLayout({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-start gap-6 min-[900px]:grid-cols-[minmax(0,1fr)_508px]">
      <div className="flex min-w-0 flex-col gap-6">{left}</div>
      <div className="flex min-w-0 flex-col gap-6">{right}</div>
    </div>
  );
}
