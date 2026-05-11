"use client";

/**
 * Three small monospace badges in the page header showing per-network
 * connection state. Visual states:
 *
 *   - connected   → solid border, full-strength foreground text
 *   - disconnected → dashed border, muted foreground (transport configured
 *                    but not yet connected, or connect failed)
 *   - pending     → dotted border, muted foreground (we haven't tried yet)
 *
 * Color is intentionally monochrome — the brutalist palette is pure
 * black/white. Border style and opacity carry the state.
 */
import { cn } from "@/lib/utils";

import type { TransportStatus } from "@/lib/herald";

type Network = "nostr" | "matrix";

export function NetworkStatusBadges({ status }: { status: TransportStatus }) {
  return (
    <div className="flex items-center gap-2">
      <Badge name="nostr" state={status.nostr} />
      <Badge name="matrix" state={status.matrix} />
    </div>
  );
}

function Badge({
  name,
  state,
}: {
  name: Network;
  state: boolean | null;
}) {
  // null  → "pending" (we haven't tried connecting yet)
  // true  → connected
  // false → disconnected / failed
  const variant: "pending" | "connected" | "failed" =
    state === null ? "pending" : state ? "connected" : "failed";

  return (
    <span
      data-state={variant}
      title={`${name}: ${variant}`}
      className={cn(
        "inline-flex items-center gap-1.5 border-2 border-foreground bg-background px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
        variant === "connected" && "shadow-[var(--shadow-brutal)]",
        variant === "failed" && "border-dashed text-muted-foreground",
        variant === "pending" && "border-dotted text-muted-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-1.5",
          variant === "connected"
            ? "bg-foreground"
            : variant === "failed"
              ? "border border-foreground"
              : "border border-dashed border-foreground",
        )}
      />
      {name}
    </span>
  );
}
