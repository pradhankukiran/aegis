"use client";

/**
 * Left rail: list of conversations the user has talked to. Click a card to
 * select that conversation. Empty state nudges the user toward the
 * AddConversationDialog.
 *
 * Each card shows:
 *   - truncated x-only pubkey (first 8 + last 4 chars) in monospace
 *   - last-activity timestamp in a small label
 */
import { cn } from "@/lib/utils";

import { truncatePubkey } from "@/lib/herald";
import type { Conversation } from "@/lib/herald";

export function ConversationList({
  conversations,
  selectedPubkey,
  onSelect,
}: {
  conversations: Conversation[];
  selectedPubkey: string | null;
  onSelect: (pubkey: string) => void;
}) {
  if (conversations.length === 0) {
    return (
      <div className="text-muted-foreground border-r-2 border-foreground p-4 text-sm">
        <p className="font-mono text-xs uppercase tracking-wider">
          no conversations yet
        </p>
        <p className="mt-2 leading-relaxed">
          Use the “Add” button to start a chat by pasting a recipient&rsquo;s
          public key.
        </p>
      </div>
    );
  }

  return (
    <ul className="border-r-2 border-foreground">
      {conversations.map((c) => {
        const isSelected = c.pubkey === selectedPubkey;
        return (
          <li key={c.pubkey}>
            <button
              type="button"
              onClick={() => onSelect(c.pubkey)}
              className={cn(
                "w-full border-b-2 border-foreground px-4 py-3 text-left transition-colors",
                isSelected
                  ? "bg-foreground text-background"
                  : "bg-background hover:bg-muted",
              )}
            >
              <div className="font-mono text-sm font-bold">
                {truncatePubkey(c.pubkey)}
              </div>
              <div
                className={cn(
                  "mt-0.5 font-mono text-[10px] uppercase tracking-wider",
                  isSelected ? "text-background/70" : "text-muted-foreground",
                )}
              >
                {formatRelative(c.lastMessageAt)}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
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
  // Older than a day — show the date.
  return dt.toISOString().slice(0, 10);
}
