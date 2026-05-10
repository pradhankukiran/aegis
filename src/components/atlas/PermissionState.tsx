"use client";

/**
 * Tiny brutalist badge surfacing the current geolocation permission state.
 *
 * State mapping:
 *   - granted → solid border, "granted" label (filled square dot)
 *   - denied  → dashed border, muted text, "denied" label
 *   - prompt  → dotted border, muted text, "prompt" label (browser will
 *               ask on first share toggle)
 *   - unknown → dotted border, muted text, "unknown" label (Permissions
 *               API unavailable on this browser)
 *
 * Color stays monochrome; border style + opacity carry the state — same
 * pattern as Herald's NetworkStatusBadges.
 */

import { cn } from "@/lib/utils";

import type { GeolocationPermissionState } from "@/lib/atlas";

export function PermissionState({
  state,
}: {
  state: GeolocationPermissionState;
}) {
  return (
    <span
      data-state={state}
      title={`geolocation permission: ${state}`}
      className={cn(
        "inline-flex items-center gap-1.5 border-2 border-foreground bg-background px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest",
        state === "granted" && "shadow-[var(--shadow-brutal)]",
        state === "denied" && "border-dashed text-muted-foreground",
        (state === "prompt" || state === "unknown") &&
          "border-dotted text-muted-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-1.5",
          state === "granted"
            ? "bg-foreground"
            : state === "denied"
              ? "border border-foreground"
              : "border border-dashed border-foreground",
        )}
      />
      geo · {state}
    </span>
  );
}
