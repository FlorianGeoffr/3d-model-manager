import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/** The app's single page-width convention (M9C), replacing the ad-hoc
 * `mx-auto max-w-*` wrapper every page previously rolled itself:
 *   "narrow"  max-w-3xl  — a single form/document column; reading measure
 *             matters more than filling the viewport.
 *   "default" max-w-6xl  — cards, tables, settings; wide but still bounded.
 *   "fluid"   full width — galleries and search grids; the grid itself
 *             handles density.
 */
const pageContainerVariants = cva("mx-auto w-full space-y-6", {
  variants: {
    width: {
      narrow: "max-w-3xl",
      default: "max-w-6xl",
      fluid: "max-w-none",
    },
  },
  defaultVariants: { width: "default" },
})

function PageContainer({
  className,
  width,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof pageContainerVariants>) {
  return (
    <div
      data-slot="page-container"
      className={cn(pageContainerVariants({ width }), className)}
      {...props}
    />
  )
}

export { PageContainer, pageContainerVariants }
