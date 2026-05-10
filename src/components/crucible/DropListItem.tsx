"use client";

/**
 * Crucible — single row in the newsroom dashboard's drop list.
 *
 * Renders a truncated drop id, a timestamp, a short preview snippet of
 * the plaintext, and an "attachment" tag if the drop carries any. Click
 * fires `onSelect` so the dashboard swaps the detail pane.
 *
 * Brutalist: solid 2px border on the active row, dense type, monospace
 * for ids and timestamps.
 */

import { Paperclip } from "lucide-react";

import { cn } from "@/lib/utils";
import { truncatePubkey } from "@/lib/crucible";
import type { DecryptedDrop } from "@/lib/crucible";

export function DropListItem({
  drop,
  selected,
  onSelect,
}: {
  drop: DecryptedDrop;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const attachmentsCount = drop.attachments?.length ?? 0;
  const preview = drop.plaintext.split("\n").find((l) => l.trim().length > 0) ?? "";

  return (
    <button
      type="button"
      onClick={() => onSelect(drop.id)}
      data-state={selected ? "active" : "idle"}
      className={cn(
        "flex w-full flex-col gap-1 border-b-2 border-foreground p-3 text-left transition-colors hover:bg-muted",
        selected && "bg-foreground text-background hover:bg-foreground",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] font-bold uppercase tracking-widest">
          {truncatePubkey(drop.id)}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-widest opacity-70">
          {formatRelative(drop.ts)}
        </span>
      </div>
      <p className="line-clamp-2 text-sm leading-snug">
        {preview || (
          <span className="opacity-50">(empty body)</span>
        )}
      </p>
      <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest opacity-70">
        {attachmentsCount > 0 ? (
          <span className="flex items-center gap-1">
            <Paperclip className="size-3" strokeWidth={2.5} />
            {attachmentsCount} file{attachmentsCount > 1 ? "s" : ""}
          </span>
        ) : (
          <span>text only</span>
        )}
        {drop.read ? <span>· read</span> : <span>· unread</span>}
      </div>
    </button>
  );
}

/** Compact ago-style timestamp (Unix seconds). */
function formatRelative(tsSec: number): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, nowSec - tsSec);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}
