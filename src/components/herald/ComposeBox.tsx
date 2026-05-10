"use client";

/**
 * Compose box at the bottom of the chat pane. Textarea + Send button.
 *
 *   - Enter         → submit
 *   - Shift+Enter   → newline
 *   - Disabled while no transport is ready (so the user can't queue a
 *     message that has nowhere to go).
 */
import { useState, useCallback } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function ComposeBox({
  onSend,
  disabled,
  sending,
}: {
  onSend: (text: string) => Promise<void> | void;
  disabled: boolean;
  sending: boolean;
}) {
  const [draft, setDraft] = useState("");

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    try {
      await onSend(text);
    } catch {
      // The hook records "failed" status; we deliberately don't restore the
      // draft because the message is still in the IDB / list as a failed
      // bubble — the user can copy the text from there if they want.
    }
  }, [draft, onSend]);

  return (
    <div className="flex flex-col gap-2 border-t-2 border-foreground bg-background p-3">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder={
          disabled
            ? "Connecting to networks…"
            : "Type a message. Enter to send, Shift+Enter for newline."
        }
        disabled={disabled || sending}
        rows={2}
        className="min-h-[60px]"
      />
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-wider">
          end-to-end encrypted via matrix · nostr · ssb
        </p>
        <Button
          type="button"
          onClick={() => {
            void submit();
          }}
          disabled={disabled || sending || !draft.trim()}
          className="shadow-[var(--shadow-brutal)]"
        >
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}
