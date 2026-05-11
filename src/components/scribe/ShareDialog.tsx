"use client";

/**
 * Share-note dialog. Two phases:
 *
 *   1. Confirm + collect recipients: the user pastes one peer pubkey per
 *      line (66-char SEC1-compressed hex, the same form `pubkeyHex` returns).
 *      Submitting calls `onShare(recipients)` which mints the Matrix room
 *      (if not already minted) and fans out share-invite directMessages.
 *   2. Result: after success, shows the room id + the joined peer list and
 *      a "Done" close action. Subsequent opens allow inviting more peers.
 *
 * On failure the error renders inline and the primary CTA returns to
 * "Share with peers".
 */

import { useCallback, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

export function ShareDialog({
  isShared,
  sharedRoomId,
  sharedWith,
  onShare,
  sharing,
  error,
  disabled,
}: {
  isShared: boolean;
  sharedRoomId: string | null;
  sharedWith: string[];
  onShare: (withPubkeys?: string[]) => Promise<string | null>;
  sharing: boolean;
  error: string | null;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [recipientsInput, setRecipientsInput] = useState("");
  // Snapshot of the room id this open-session minted (or last saw).
  const [localRoomId, setLocalRoomId] = useState<string | null>(null);

  const effectiveRoomId = localRoomId ?? sharedRoomId;
  const showResult = (isShared || effectiveRoomId !== null) && !sharing;

  // Parse the textarea into a clean list of pubkey hex strings, one per
  // line. We don't validate the hex shape here — the hook layer does the
  // strict 66-char check and surfaces a useful error.
  const parsedRecipients = useMemo<string[]>(() => {
    return recipientsInput
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }, [recipientsInput]);

  const handleShare = useCallback(async () => {
    const result = await onShare(parsedRecipients);
    if (result) {
      setLocalRoomId(result);
      setRecipientsInput("");
    }
  }, [onShare, parsedRecipients]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="neutral"
          disabled={disabled}
          className="shadow-[var(--shadow-brutal)]"
        >
          {isShared ? "Invite more" : "Share"}
        </Button>
      </DialogTrigger>
      <DialogContent className="border-2 border-foreground rounded-none shadow-[var(--shadow-brutal-lg)]">
        <DialogHeader>
          <DialogTitle className="font-heading text-lg font-black uppercase tracking-tight">
            {showResult ? "Note is shared" : "Share this note"}
          </DialogTitle>
          <DialogDescription>
            {showResult
              ? "A Matrix room has been created for collaborative edits. Paste more pubkeys below to invite additional peers — the room stays the same; each peer is sent a share-invite DM."
              : "Sharing creates an encrypted Matrix room for collaborative editing. Each recipient pubkey will receive a share-invite DM with the room id and the CID of the encrypted envelope blob."}
          </DialogDescription>
        </DialogHeader>

        {showResult && effectiveRoomId ? (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
              matrix room id
            </p>
            <p className="break-all border-2 border-foreground bg-muted p-2 font-mono text-xs">
              {effectiveRoomId}
            </p>
            {sharedWith.length > 0 ? (
              <>
                <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
                  invited peers ({sharedWith.length})
                </p>
                <ul className="border-2 border-foreground bg-muted p-2 font-mono text-[10px]">
                  {sharedWith.map((pk) => (
                    <li key={pk} className="break-all">
                      {pk}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <label
            className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest"
            htmlFor="scribe-share-recipients"
          >
            Recipient pubkeys (66 hex chars, one per line)
          </label>
          <Textarea
            id="scribe-share-recipients"
            value={recipientsInput}
            onChange={(e) => setRecipientsInput(e.target.value)}
            placeholder="03a1b2c3...&#10;02e4d5f6..."
            spellCheck={false}
            rows={4}
            className="resize-none font-mono text-xs"
            disabled={sharing}
          />
          <p className="text-muted-foreground text-xs leading-relaxed">
            Paste one peer pubkey per line (the same SEC1-compressed form
            other Aegis features use). Leave empty to mint an open room you
            invite peers to later.
          </p>
          {error ? (
            <p className="font-mono text-xs text-foreground">{error}</p>
          ) : null}
        </div>

        <div className="flex justify-end gap-2">
          {showResult ? (
            <Button
              type="button"
              variant="neutral"
              onClick={() => {
                setOpen(false);
                setLocalRoomId(null);
                setRecipientsInput("");
              }}
            >
              Done
            </Button>
          ) : null}
          <Button
            type="button"
            variant="neutral"
            onClick={() => setOpen(false)}
            disabled={sharing}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              void handleShare();
            }}
            disabled={sharing}
          >
            {sharing
              ? "Sharing…"
              : showResult
                ? "Invite peers"
                : parsedRecipients.length > 0
                  ? `Share with ${parsedRecipients.length}`
                  : "Create shared room"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
