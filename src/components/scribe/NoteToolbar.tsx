"use client";

/**
 * Header strip for the active note: shows the title, exposes Share and
 * Delete actions, and confirms destructive operations through a separate
 * Dialog instance.
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

import { ShareDialog } from "./ShareDialog";

export function NoteToolbar({
  title,
  id,
  isShared,
  sharedRoomId,
  onShare,
  sharing,
  shareError,
  onDelete,
  deleteDisabled,
  shareDisabled,
}: {
  title: string;
  id: string;
  isShared: boolean;
  sharedRoomId: string | null;
  onShare: () => Promise<string | null>;
  sharing: boolean;
  shareError: string | null;
  onDelete: () => Promise<void>;
  deleteDisabled?: boolean;
  shareDisabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-foreground bg-background px-4 py-3">
      <div className="flex min-w-0 flex-col">
        <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
          note · {id.slice(0, 8)}
        </p>
        <h2 className="truncate text-lg font-black uppercase tracking-tight">
          {title || "Untitled note"}
        </h2>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ShareDialog
          isShared={isShared}
          sharedRoomId={sharedRoomId}
          onShare={onShare}
          sharing={sharing}
          error={shareError}
          disabled={shareDisabled}
        />
        <DeleteButton onDelete={onDelete} disabled={deleteDisabled} />
      </div>
    </div>
  );
}

function DeleteButton({
  onDelete,
  disabled,
}: {
  onDelete: () => Promise<void>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleConfirm = useCallback(async () => {
    setBusy(true);
    try {
      await onDelete();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }, [onDelete]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          disabled={disabled}
          className="shadow-[var(--shadow-brutal)]"
        >
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent className="border-2 border-foreground rounded-none shadow-[var(--shadow-brutal-lg)]">
        <DialogHeader>
          <DialogTitle className="font-heading text-lg font-black uppercase tracking-tight">
            Delete this note?
          </DialogTitle>
          <DialogDescription>
            The encrypted blob is removed from this browser. There is no
            recovery — if the note is the only copy, it&rsquo;s gone.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => {
              void handleConfirm();
            }}
            disabled={busy}
          >
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
