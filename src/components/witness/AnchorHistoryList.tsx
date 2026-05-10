"use client";

/**
 * Local history of anchors created on this device. Each row navigates to the
 * proof viewer at `/witness/<hash>`. Empty state nudges the user toward the
 * dropzone above.
 *
 * Display is intentionally compact — file name (if any), truncated hash, a
 * row of three brutalist badges for per-network status, and a relative
 * timestamp.
 */
import Link from "next/link";
import { CheckCircle2, XCircle } from "lucide-react";

import { cn } from "@/lib/utils";

import type { AnchorRecord } from "@/lib/witness";

export function AnchorHistoryList({
  records,
}: {
  records: AnchorRecord[];
}) {
  if (records.length === 0) {
    return (
      <div className="text-muted-foreground border-2 border-foreground bg-background p-4 text-sm">
        <p className="font-mono text-xs uppercase tracking-wider">
          no anchors yet
        </p>
        <p className="mt-2 leading-relaxed">
          Anchor a file above and it will appear here, with a shareable
          proof URL anyone can verify.
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {records.map((r) => (
        <li key={r.hash}>
          <Link
            href={`/witness/${r.hash}`}
            className={cn(
              "block border-2 border-foreground bg-background px-4 py-3 transition-shadow hover:shadow-[var(--shadow-brutal)]",
            )}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-mono text-sm font-bold break-all">
                {r.fileName ?? "anchor"}
              </p>
              <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-wider">
                {formatRelative(r.createdAt)}
              </p>
            </div>
            <p className="text-muted-foreground mt-1 font-mono text-xs break-all">
              {truncateHash(r.hash)}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {r.networkResults.map((nr) => (
                <span
                  key={nr.network}
                  data-state={nr.ok ? "ok" : "fail"}
                  title={`${nr.network}: ${nr.ok ? "anchored" : (nr.reason ?? "failed")}`}
                  className={cn(
                    "inline-flex items-center gap-1 border-2 border-foreground px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest",
                    nr.ok
                      ? "bg-background"
                      : "border-dashed bg-background text-muted-foreground",
                  )}
                >
                  {nr.ok ? (
                    <CheckCircle2 className="size-2.5" />
                  ) : (
                    <XCircle className="size-2.5" />
                  )}
                  {nr.network}
                </span>
              ))}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function truncateHash(hex: string): string {
  if (hex.length <= 16) return hex;
  return `${hex.slice(0, 10)}…${hex.slice(-6)}`;
}

function formatRelative(ts: number): string {
  const dt = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return dt.toISOString().slice(0, 10);
}
