"use client";

/**
 * Big brutalist on/off control for the share-service loop.
 *
 * Off → "share with circle" CTA (the call-to-action when no session is running).
 * On  → "sharing with N members · last fix HH:MM:SS" status + a Stop button.
 *
 * The first activation triggers the browser geolocation permission prompt
 * (handled inside the share-service on its first tick). If the user has
 * already denied the permission we surface a friendly explanation via
 * `lastErrorMessage` instead of toggling on, so the UI stays in sync with
 * reality.
 */

import { Button } from "@/components/ui/button";

import type { ShareSession } from "@/lib/atlas";

export function ShareToggle({
  session,
  memberCount,
  lastTickAt,
  lastErrorMessage,
  disabled,
  onStart,
  onStop,
}: {
  session: ShareSession;
  memberCount: number;
  lastTickAt: number | null;
  lastErrorMessage: string | null;
  disabled: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const active = session.active;
  const lastSeenLabel = lastTickAt ? formatLocalTime(lastTickAt) : "—";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-foreground bg-background px-4 py-3 sm:px-6">
      <div className="min-w-0">
        <p className="font-mono text-[10px] uppercase tracking-widest">
          live share
        </p>
        {active ? (
          <p className="mt-0.5 truncate font-mono text-sm font-bold">
            sharing with {memberCount} member{memberCount === 1 ? "" : "s"}
            <span className="text-muted-foreground">
              {" · last fix "}
              {lastSeenLabel}
            </span>
          </p>
        ) : (
          <p className="mt-0.5 truncate font-mono text-sm font-bold">
            off — your location is not being shared
          </p>
        )}
        {lastErrorMessage ? (
          <p className="mt-1 font-mono text-[10px] text-muted-foreground">
            {lastErrorMessage}
          </p>
        ) : null}
      </div>
      {active ? (
        <Button
          type="button"
          variant="neutral"
          onClick={onStop}
          className="shadow-[var(--shadow-brutal)]"
        >
          Stop sharing
        </Button>
      ) : (
        <Button
          type="button"
          onClick={onStart}
          disabled={disabled}
          className="shadow-[var(--shadow-brutal-lg)]"
        >
          {memberCount === 0
            ? "Share with circle (add members first)"
            : "Share with circle"}
        </Button>
      )}
    </div>
  );
}

/** Format ts (Unix ms) as `HH:MM:SS`, local time. */
function formatLocalTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
