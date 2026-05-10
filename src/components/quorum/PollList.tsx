"use client";

/**
 * List of every poll the local device knows about (mine + discovered via
 * the transport bridge). Sorted by createdAt desc.
 *
 * Status line per poll surfaces:
 *   - "open · closes HH:MM:SS"  while pre-close.
 *   - "closes in HH:MM:SS"      while past close-soon threshold.
 *   - "closed"                   once close passed.
 *
 * Each row links to `/quorum/<id>`. We use the brutalist shadow on hover
 * to give the row a tactile lift; no actual `react-router` Link is needed
 * because the page already pulls from IDB and we don't prefetch poll
 * detail.
 */

import Link from "next/link";

import { truncatePubkey } from "@/lib/quorum";
import type { PollMeta } from "@/lib/quorum";

export function PollList({
  polls,
  myPubkey,
  now,
}: {
  polls: PollMeta[];
  /** Voter's pubkey (x-only 64-hex lowercase). Used to badge "yours". */
  myPubkey: string | null;
  /** Unix ms tick from parent — keeps the countdown live. */
  now: number;
}) {
  if (polls.length === 0) {
    return (
      <div className="border-2 border-foreground bg-background p-6">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          no polls yet
        </p>
        <p className="mt-2 max-w-xl text-sm leading-relaxed">
          Create one with the button above. Polls you create are fanned out
          across Nostr, Matrix, and SSB; polls your peers create surface
          here automatically when their event lands on any connected
          network.
        </p>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {polls.map((p) => {
        const mine = myPubkey != null && p.owner === myPubkey;
        const status = describeStatus(p, now);
        return (
          <li key={p.id}>
            <Link
              href={`/quorum/${p.id}`}
              className="block border-2 border-foreground bg-background p-4 shadow-[var(--shadow-brutal-lg)] transition-all hover:translate-x-[-1px] hover:translate-y-[-1px] focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="min-w-0 font-heading text-lg font-black uppercase tracking-tight">
                  {p.title}
                </h3>
                {mine ? (
                  <span className="border-2 border-dashed border-foreground bg-background px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest">
                    yours
                  </span>
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] uppercase tracking-widest">
                <span>
                  <span className="text-muted-foreground">status </span>
                  {status}
                </span>
                <span>
                  <span className="text-muted-foreground">options </span>
                  {p.options.length}
                </span>
                <span>
                  <span className="text-muted-foreground">voters </span>
                  {p.voters.length === 0 ? "open" : p.voters.length}
                </span>
                <span>
                  <span className="text-muted-foreground">by </span>
                  {truncatePubkey(p.owner)}
                </span>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function describeStatus(p: PollMeta, now: number): string {
  const remaining = p.closeUnix - now;
  if (remaining <= 0) return "closed";
  const totalSec = Math.floor(remaining / 1000);
  const days = Math.floor(totalSec / 86400);
  const hr = Math.floor((totalSec % 86400) / 3600);
  const min = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (days > 0) {
    return `open · closes in ${days}d ${pad(hr)}:${pad(min)}:${pad(sec)}`;
  }
  return `open · closes in ${pad(hr)}:${pad(min)}:${pad(sec)}`;
}
