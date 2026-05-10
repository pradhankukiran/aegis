"use client";

/**
 * Small brutalist badge that surfaces a beacon's lifecycle state.
 *
 * Border-style + dot-fill encodes the variant — colour is intentionally
 * monochrome (the brutalist palette is pure black/white). Same encoding
 * pattern Herald's `NetworkStatusBadges` uses, so the visual vocabulary
 * across features stays consistent.
 *
 * Variants:
 *   - pending     → solid border, hollow dot ("armed, no check-in yet")
 *   - checked-in  → solid border, filled dot ("counted, deadline bumped")
 *   - fired       → dashed border ("the release went out")
 *   - cancelled   → dotted border ("the user pulled the plug before fire")
 *   - expired     → dashed muted border ("terminal grace exceeded")
 */
import { cn } from "@/lib/utils";

import type { BeaconStatus } from "@/lib/beacon";

const LABEL: Record<BeaconStatus, string> = {
  pending: "pending",
  "checked-in": "checked-in",
  fired: "fired",
  cancelled: "cancelled",
  expired: "expired",
};

export function StatusBadge({ status }: { status: BeaconStatus }) {
  const variant = status;
  return (
    <span
      data-state={variant}
      className={cn(
        "inline-flex items-center gap-1.5 border-2 border-foreground bg-background px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
        variant === "pending" && "shadow-[var(--shadow-brutal)]",
        variant === "checked-in" && "shadow-[var(--shadow-brutal)] bg-muted",
        variant === "fired" && "border-dashed",
        variant === "cancelled" && "border-dotted text-muted-foreground",
        variant === "expired" && "border-dashed text-muted-foreground",
      )}
      title={`status: ${LABEL[variant]}`}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-1.5",
          variant === "checked-in"
            ? "bg-foreground"
            : variant === "fired"
              ? "bg-foreground"
              : variant === "cancelled"
                ? "border border-dotted border-foreground"
                : variant === "expired"
                  ? "border border-dashed border-foreground"
                  : "border border-foreground",
        )}
      />
      {LABEL[variant]}
    </span>
  );
}
