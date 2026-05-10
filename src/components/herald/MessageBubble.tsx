"use client";

/**
 * Single chat bubble. Mine = right-aligned with a heavier brutal shadow,
 * theirs = left-aligned with the standard one. Status text below the body
 * narrates the lifecycle ("sending…", "sent via matrix", "failed",
 * "received via nostr").
 *
 * Design: 2px border, no border-radius (zeroed at the theme level), monospace
 * for status to give it a "telemetry strip" feel.
 */
import { cn } from "@/lib/utils";

import type { Message } from "@/lib/herald";

export function MessageBubble({ message }: { message: Message }) {
  const mine = message.mine;
  return (
    <div
      data-mine={mine ? "true" : "false"}
      className={cn(
        "flex w-full flex-col gap-1",
        mine ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "max-w-[85%] border-2 border-foreground bg-background px-3 py-2 text-sm whitespace-pre-wrap break-words",
          mine
            ? "shadow-[var(--shadow-brutal-lg)] bg-foreground text-background"
            : "shadow-[var(--shadow-brutal)]",
        )}
      >
        {message.body}
      </div>
      <div
        className={cn(
          "font-mono text-[10px] tracking-wide uppercase",
          message.status === "failed"
            ? "text-foreground"
            : "text-muted-foreground",
        )}
      >
        {renderStatus(message)}
      </div>
    </div>
  );
}

function renderStatus(m: Message): string {
  switch (m.status) {
    case "sending":
      return "sending…";
    case "sent":
      return m.via ? `sent via ${m.via}` : "sent";
    case "failed":
      return "failed";
    case "received":
      return m.via ? `received via ${m.via}` : "received";
  }
}
