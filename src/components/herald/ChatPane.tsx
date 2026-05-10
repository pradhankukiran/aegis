"use client";

/**
 * Center column: header (recipient pubkey), scrollable message list, compose
 * box. Auto-scrolls to bottom whenever a new message arrives.
 *
 * Empty state when no conversation is selected encourages picking one from
 * the rail or adding a new one.
 */
import { useEffect, useRef } from "react";

import { ComposeBox } from "./ComposeBox";
import { MessageBubble } from "./MessageBubble";

import { truncatePubkey } from "@/lib/herald";
import type { Message } from "@/lib/herald";

export function ChatPane({
  conversationPubkey,
  messages,
  onSend,
  sending,
  composeDisabled,
}: {
  conversationPubkey: string | null;
  messages: Message[];
  onSend: (text: string) => Promise<void> | void;
  sending: boolean;
  composeDisabled: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll-to-bottom when new messages arrive. Only nudges when the
  // user is already near the bottom — if they've scrolled up to read
  // history, don't yank them away.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  if (!conversationPubkey) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-md text-center">
            <p className="text-muted-foreground font-mono text-xs uppercase tracking-wider">
              no conversation selected
            </p>
            <p className="mt-3 text-sm leading-relaxed">
              Pick a conversation from the left, or add a new one with a
              recipient&rsquo;s public key.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b-2 border-foreground bg-background p-4">
        <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-wider">
          conversation
        </p>
        <p className="font-mono text-sm font-bold">
          {truncatePubkey(conversationPubkey)}
        </p>
      </div>
      <div
        ref={scrollerRef}
        className="flex flex-1 flex-col gap-3 overflow-y-auto p-4"
      >
        {messages.length === 0 ? (
          <div className="text-muted-foreground my-auto text-center font-mono text-xs uppercase tracking-wider">
            no messages yet — say hello
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}
      </div>
      <ComposeBox
        onSend={onSend}
        disabled={composeDisabled}
        sending={sending}
      />
    </div>
  );
}
