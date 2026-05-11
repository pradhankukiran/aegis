"use client";

/**
 * Share-note confirmation dialog. Two phases:
 *
 *   1. Confirm: explain that sharing creates a Matrix room scaffold and
 *      that subsequent edits will (in the live-infra tier) ship CRDT
 *      updates to peers.
 *   2. Result: after success, show the room id and a "Done" close action.
 *
 * On failure the error message renders inline and the primary CTA returns
 * to "Create shared room".
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

export function ShareDialog({
  isShared,
  sharedRoomId,
  onShare,
  sharing,
  error,
  disabled,
}: {
  isShared: boolean;
  sharedRoomId: string | null;
  onShare: () => Promise<string | null>;
  sharing: boolean;
  error: string | null;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // After a successful share within this open session we want to flip the
  // dialog to a "Done" state without unmounting it.
  const [localRoomId, setLocalRoomId] = useState<string | null>(null);

  const handleShare = useCallback(async () => {
    const roomId = await onShare();
    if (roomId) setLocalRoomId(roomId);
  }, [onShare]);

  const effectiveRoomId = localRoomId ?? sharedRoomId;
  const showResult = isShared || effectiveRoomId !== null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="neutral"
          disabled={disabled}
          className="shadow-[var(--shadow-brutal)]"
        >
          {isShared ? "Shared" : "Share"}
        </Button>
      </DialogTrigger>
      <DialogContent className="border-2 border-foreground rounded-none shadow-[var(--shadow-brutal-lg)]">
        <DialogHeader>
          <DialogTitle className="font-heading text-lg font-black uppercase tracking-tight">
            {showResult ? "Note is shared" : "Share this note"}
          </DialogTitle>
          <DialogDescription>
            {showResult
              ? "A Matrix room has been created for collaborative edits. The room id is the address peers can join."
              : "Sharing creates a Matrix room scaffold for collaborative editing. Once shared, content updates leave this device and travel to peers in the room."}
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
            <p className="text-muted-foreground text-xs leading-relaxed">
              Live CRDT sync requires a connected Matrix homeserver. For now
              the room exists as a placeholder — body edits still save to
              this device.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="border-2 border-foreground bg-muted p-3 text-sm">
              <p className="font-mono text-[10px] uppercase tracking-widest">
                heads up
              </p>
              <p className="mt-1 leading-relaxed">
                Sharing changes the threat model: peers in the room can read
                your edits as they happen. Personal notes stay sealed in
                this browser until you press this button.
              </p>
            </div>
            {error ? (
              <p className="font-mono text-xs text-foreground">{error}</p>
            ) : null}
          </div>
        )}

        <div className="flex justify-end gap-2">
          {showResult && effectiveRoomId ? (
            <Button
              type="button"
              onClick={() => {
                setOpen(false);
                setLocalRoomId(null);
              }}
            >
              Done
            </Button>
          ) : (
            <>
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
                {sharing ? "Sharing…" : "Create shared room"}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
