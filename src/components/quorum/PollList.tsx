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
 * Each row links to `/quorum/<id>`. We wrap a Card via `asChild` so the
 * brutalist theming (border, shadow, lift on hover) is centralised in
 * the primitive — no raw shadow utility classes here.
 */

import Link from "next/link";

import { Card } from "@/components/ui/card";

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
      <Card className="gap-2 px-6 py-6">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          no polls yet
        </p>
        <p className="max-w-xl text-sm leading-relaxed">
          Create one with the button above. Polls you create are fanned out
          across Nostr, Matrix, and SSB; polls your peers create surface
          here automatically when their event lands on any connected
          network.
        </p>
      </Card>
    );
  }
  return (
    <ul className="flex flex-col gap-4">
      {polls.map((p) => {
        const mine = myPubkey != null && p.owner === myPubkey;
        const status = describeStatus(p, now);
        return (
          <li key={p.id}>
            <Card
              asChild
              className="gap-0 px-0 py-0 transition-all hover:translate-x-boxShadowX hover:translate-y-boxShadowY hover:shadow-none focus-within:translate-x-boxShadowX focus-within:translate-y-boxShadowY focus-within:shadow-none"
            >
              <Link
                href={`/quorum/${p.id}`}
                className="block p-4 focus:outline-none"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="min-w-0 font-heading text-lg font-black uppercase tracking-tight">
                    {p.title}
                  </h3>
                  {mine ? (
                    <span className="bg-main text-main-foreground border-2 border-foreground px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest">
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
            </Card>
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
