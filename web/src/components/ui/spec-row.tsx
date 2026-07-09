import * as React from "react"

import { cn } from "@/lib/utils"

export interface SpecItem {
  icon?: React.ReactNode
  label: React.ReactNode
}

/** Datasheet-style metadata line: a monospaced, dot-separated, icon-prefixed
 * row (print time · material · dimensions). Null/undefined entries and entries
 * with an empty label are skipped; renders nothing when nothing is present. */
function SpecRow({
  items,
  className,
  ...props
}: React.ComponentProps<"div"> & { items: Array<SpecItem | null | undefined> }) {
  const present = items.filter(
    (item): item is SpecItem => item != null && item.label != null && item.label !== "",
  )
  if (present.length === 0) return null

  return (
    <div
      data-slot="spec-row"
      className={cn(
        "flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-xs text-muted-foreground",
        className,
      )}
      {...props}
    >
      {present.map((item, i) => (
        <React.Fragment key={i}>
          {i > 0 && (
            <span aria-hidden="true" className="text-muted-foreground/50">
              ·
            </span>
          )}
          <span className="inline-flex items-center gap-1 [&>svg]:size-3">
            {item.icon}
            {item.label}
          </span>
        </React.Fragment>
      ))}
    </div>
  )
}

export { SpecRow }
