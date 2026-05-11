"use client";

/**
 * Dialog for adding a new circle member by pasting their pubkey hex.
 *
 * Accepts:
 *   - 64 hex chars (x-only Nostr pubkey form)
 *   - 66 hex chars (SEC1-compressed: parity byte + x)
 *
 * Both are normalized to the canonical x-only 64-char lowercase form via
 * `normalizePubkey` before storage. An optional nickname is preserved
 * verbatim (trimmed) for display.
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

import { isValidPubkeyHex, normalizePubkey } from "@/lib/atlas";

export function AddMemberDialog({
  onAdd,
}: {
  onAdd: (pubkey: string, nickname?: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [draftNick, setDraftNick] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const trimmed = draftKey.trim();
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
      await onAdd(normalized, draftNick.trim() || undefined);
      setDraftKey("");
      setDraftNick("");
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add.");
    } finally {
      setBusy(false);
    }
  }, [trimmed, valid, onAdd, draftNick]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="neutral"
          size="xs"
          className="shadow-[var(--shadow-brutal)]"
        >
          + add
        </Button>
      </DialogTrigger>
      <DialogContent className="rounded-none border-2 border-foreground shadow-[var(--shadow-brutal-lg)]">
        <DialogHeader>
          <DialogTitle className="font-heading text-lg font-black uppercase tracking-tight">
            Add to circle
          </DialogTitle>
          <DialogDescription>
            Paste a peer&rsquo;s public key. They will receive your encrypted
            position updates when sharing is active.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label
              className="font-mono text-[10px] uppercase tracking-widest"
              htmlFor="atlas-add-pubkey"
            >
              pubkey
            </label>
            <Input
              id="atlas-add-pubkey"
              value={draftKey}
              onChange={(e) => {
                setDraftKey(e.target.value);
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
          </div>
          <div className="flex flex-col gap-1">
            <label
              className="font-mono text-[10px] uppercase tracking-widest"
              htmlFor="atlas-add-nick"
            >
              nickname (optional)
            </label>
            <Input
              id="atlas-add-nick"
              value={draftNick}
              onChange={(e) => setDraftNick(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="display name"
              disabled={busy}
              maxLength={48}
            />
          </div>
          {error ? (
            <p className="font-mono text-xs text-foreground">{error}</p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="neutral"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              setDraftKey("");
              setDraftNick("");
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
