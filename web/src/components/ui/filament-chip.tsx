import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/** Normalize a hex color to `#RRGGBB`. Accepts `#RRGGBB`, bare `RRGGBB`, and
 * 8-digit `RRGGBBAA` / `#RRGGBBAA` (the printer's AMS `tray_color` carries a
 * trailing alpha) — the alpha is stripped. Returns `null` for empty or
 * unparseable input so callers render a placeholder instead of emitting an
 * invalid inline style. */
export function normalizeHex(input?: string | null): string | null {
  if (!input) return null
  const hex = input.trim().replace(/^#/, "")
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) return null
  return `#${hex.slice(0, 6)}`
}

const filamentChipVariants = cva("inline-flex items-center gap-1.5 align-middle", {
  variants: {
    size: {
      sm: "text-xs",
      md: "text-sm",
    },
  },
  defaultVariants: { size: "sm" },
})

const SWATCH_SIZE = { sm: "size-3", md: "size-4" } as const

/** The redesign's signature motif: a rounded filament-color swatch, reused for
 * AMS slots, tags, and the viewer's per-part recolor control. */
function FilamentChip({
  color,
  label,
  material,
  size = "sm",
  className,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof filamentChipVariants> & {
    color?: string | null
    label?: string
    material?: string
  }) {
  const hex = normalizeHex(color)
  const description = [label, material, hex ?? "no color"].filter(Boolean).join(" · ")
  const swatchClass = SWATCH_SIZE[size ?? "sm"]

  return (
    <span
      data-slot="filament-chip"
      className={cn(filamentChipVariants({ size }), className)}
      {...props}
    >
      {hex ? (
        <span
          aria-hidden="true"
          title={description}
          className={cn(swatchClass, "shrink-0 rounded-full border border-border/60")}
          style={{ backgroundColor: hex }}
        />
      ) : (
        <span
          aria-hidden="true"
          title={description}
          className={cn(
            swatchClass,
            "shrink-0 rounded-full border border-dashed border-muted-foreground/40 bg-muted",
          )}
        />
      )}
      {(label || material) && (
        <span className="truncate">
          {label}
          {label && material ? " " : ""}
          {material ? <span className="font-mono text-muted-foreground">{material}</span> : null}
        </span>
      )}
      <span className="sr-only">{description}</span>
    </span>
  )
}

export { FilamentChip, filamentChipVariants }
