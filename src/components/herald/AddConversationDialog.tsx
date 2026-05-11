"use client";

/**
 * Dialog for adding a new conversation by pasting a recipient's pubkey hex.
 *
 * Accepts:
 *   - 64 hex chars (x-only Nostr pubkey form)
 *   - 66 hex chars (SEC1-compressed: parity byte + x)
 *
 * Both are normalized to the canonical x-only 64-char lowercase form via
 * the herald hook before storage.
 */
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import { isValidPubkeyHex, normalizePubkey } from "@/lib/herald";

export function AddConversationDialog({
  onAdd,
}: {
  onAdd: (pubkey: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmed = draft.trim();
  const valid = isValidPubkeyHex(trimmed);

  const submit = useCallback(async () => {
    if (!valid) {
      setError("Pubkey must be 64 or 66 hex chars (0-9 a-f).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const normalized = normalizePubkey(trimmed);
      await onAdd(normalized);
      setDraft("");
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add.");
    } finally {
      setBusy(false);
    }
  }, [trimmed, valid, onAdd]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="neutral"
          className="shadow-[var(--shadow-brutal)]"
        >
          + Add conversation
        </Button>
      </DialogTrigger>
      <DialogContent className="border-2 border-foreground rounded-none shadow-[var(--shadow-brutal-lg)]">
        <DialogHeader>
          <DialogTitle className="font-heading text-lg font-black uppercase tracking-tight">
            New conversation
          </DialogTitle>
          <DialogDescription>
            Paste your recipient&rsquo;s public key. Hex only, 64 or 66
            characters.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="abcdef0123… (64 or 66 hex chars)"
            disabled={busy}
            spellCheck={false}
            className="font-mono text-sm"
          />
          {error ? (
            <p className="font-mono text-xs text-foreground">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="neutral"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              setDraft("");
              setError(null);
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || !valid}
            onClick={() => {
              void submit();
            }}
          >
            {busy ? "Adding…" : "Add"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
