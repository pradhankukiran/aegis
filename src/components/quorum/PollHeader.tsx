"use client";

/**
 * Per-poll header rendered above VotePane or TallyView. Shows:
 *
 *   - Poll title.
 *   - Close countdown (or "closed N seconds ago" once close passed).
 *   - Truncated owner pubkey + "shared by" hint.
 *   - The drand round the ballots are timelocked to (so anyone validating
 *     the protocol can sanity-check it matches their own projection).
 *
 * The countdown ticks once a second via a parent prop (`now`) so the
 * component itself stays stateless — the page already ticks for the
 * `usePoll` reveal flag, and we share that source of truth.
 */

import { truncatePubkey } from "@/lib/quorum";
import type { PollMeta } from "@/lib/quorum";

export function PollHeader({
  poll,
  now,
}: {
  poll: PollMeta;
  /** Unix ms from a parent tick. Used for the live countdown. */
  now: number;
}) {
  const remaining = poll.closeUnix - now;
  const closed = remaining <= 0;
  return (
    <div className="border-b-2 border-foreground bg-background px-4 py-4 sm:px-6">
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        sealed-ballot poll
      </p>
      <h2 className="mt-1 font-heading text-2xl font-black uppercase tracking-tight sm:text-3xl">
        {poll.title}
      </h2>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] uppercase tracking-widest">
        <span>
          <span className="text-muted-foreground">shared by </span>
          {truncatePubkey(poll.owner)}
        </span>
        <span>
          <span className="text-muted-foreground">round </span>
          {poll.drandRound}
        </span>
        <span>
          <span className="text-muted-foreground">
            {closed ? "closed " : "closes "}
          </span>
          {closed
            ? formatPast(remaining)
            : formatCountdown(remaining)}
        </span>
      </div>
    </div>
  );
}

/** Format a positive ms countdown as `Xd HH:MM:SS` or `HH:MM:SS` if <1d. */
function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSec / 86400);
  const hr = Math.floor((totalSec % 86400) / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const tail = `${pad(hr)}:${pad(min)}:${pad(sec)}`;
  return days > 0 ? `${days}d ${tail}` : tail;
}

/** Format a negative ms (already passed) as `N min ago` / `N hr ago`. */
function formatPast(ms: number): string {
  const past = Math.abs(ms);
  const sec = Math.floor(past / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}
