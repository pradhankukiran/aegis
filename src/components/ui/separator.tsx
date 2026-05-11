"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Separator — restyled for neobrutalism.
 *
 * Neobrutalism.dev's registry doesn't publish a separator component, so
 * we keep a thin local primitive that maps to the neobrutalism `border`
 * colour token (hard black in the default light theme) and is 2px thick
 * (matches the border-2 weight used by every other ui/ primitive).
 *
 * Implemented as a plain `<div role="separator">` rather than the
 * base-ui Separator we used to import — that dependency is being phased
 * out across the ui/ folder. role + aria-orientation are wired manually
 * so screen readers still announce it correctly.
 */
function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<"div"> & {
  orientation?: "horizontal" | "vertical"
  decorative?: boolean
}) {
  return (
    <div
      data-slot="separator"
      data-orientation={orientation}
      role={decorative ? "none" : "separator"}
      aria-orientation={decorative ? undefined : orientation}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal"
          ? "h-0.5 w-full"
          : "h-full w-0.5 self-stretch",
        className,
      )}
      {...props}
    />
  )
}

export { Separator }
