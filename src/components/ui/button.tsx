import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Button — neobrutalism.dev canonical variant set.
 *
 * Only the four variants the upstream registry ships are exposed:
 *
 *   - `default`  → blue chunky CTA on bg-main, hard offset shadow that
 *                  collapses on hover (the "press in" feel).
 *   - `neutral`  → secondary action. White-ish background, same hard
 *                  shadow + hover collapse.
 *   - `noShadow` → blue button without a shadow. Used inside dense
 *                  layouts (e.g. inline cells) where the shadow would
 *                  collide with the row chrome.
 *   - `reverse`  → starts flush, lifts on hover (inverse of `default`).
 *
 * Sizes track the upstream `default | sm | lg | icon` set plus the
 * Aegis-specific `xs` / `icon-xs` (used by Scribe toolbar, Witness
 * dropzone, Crucible drop list). Removing those would cascade into ~5
 * feature files; keeping them costs two lines.
 *
 * Back-compat variants (`outline`, `ghost`, `destructive`, `secondary`,
 * `link`) were intentionally removed. Call sites map to the canonical
 * set as follows:
 *
 *   outline   → neutral
 *   ghost     → drop the variant (use default secondary or neutral with
 *               a smaller size)
 *   secondary → neutral
 *   destructive → default + className="bg-red-500"
 *   link      → wrap in a plain `<Link>` instead of a Button
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-base text-sm font-base ring-offset-white transition-all gap-2 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "text-main-foreground bg-main border-2 border-border shadow-shadow hover:translate-x-boxShadowX hover:translate-y-boxShadowY hover:shadow-none",
        noShadow: "text-main-foreground bg-main border-2 border-border",
        neutral:
          "bg-secondary-background text-foreground border-2 border-border shadow-shadow hover:translate-x-boxShadowX hover:translate-y-boxShadowY hover:shadow-none",
        reverse:
          "text-main-foreground bg-main border-2 border-border hover:translate-x-reverseBoxShadowX hover:translate-y-reverseBoxShadowY hover:shadow-shadow",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 px-3",
        xs: "h-7 px-2 text-xs gap-1 [&_svg:not([class*='size-'])]:size-3",
        lg: "h-11 px-8",
        icon: "size-10",
        "icon-xs": "size-7 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-9",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
