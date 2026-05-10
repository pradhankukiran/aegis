"use client";

/**
 * Confirmation dialog for the manual "Trigger now (test)" action.
 *
 * Firing publishes the release event across every connected network — the
 * payload becomes public the instant any peer sees it. We surface an
 * explicit confirm so a fat-fingered click on the BeaconDetail page
 * doesn't dump a sensitive message onto the wire prematurely.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import type { Beacon } from "@/lib/beacon";

export function FireConfirmDialog({
  beacon,
  onConfirm,
  isWorking,
}: {
  beacon: Beacon;
  onConfirm: () => Promise<void>;
  isWorking: boolean;
}) {
  const [open, setOpen] = useState(false);

  const confirm = async () => {
    await onConfirm();
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            className="shadow-[var(--shadow-brutal)]"
          />
        }
      >
        Trigger now (test)
      </DialogTrigger>
      <DialogContent className="border-2 border-foreground rounded-none shadow-[var(--shadow-brutal-lg)]">
        <DialogHeader>
          <DialogTitle className="font-heading text-lg font-black uppercase tracking-tight">
            Fire beacon now?
          </DialogTitle>
          <DialogDescription>
            This publishes the release event across every connected network.
            The payload becomes public to anyone subscribed to Aegis. There is
            no undo.
          </DialogDescription>
        </DialogHeader>
        <div className="border-2 border-foreground bg-muted p-3 text-sm">
          <p className="font-mono text-[10px] uppercase tracking-widest">
            Beacon
          </p>
          <p className="mt-1 font-bold">{beacon.title}</p>
          <p className="text-muted-foreground mt-1 font-mono text-[10px] break-all uppercase tracking-wider">
            id {beacon.id}
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={isWorking}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={isWorking}
            onClick={() => {
              void confirm();
            }}
            className="shadow-[var(--shadow-brutal)]"
          >
            {isWorking ? "Firing…" : "Fire now"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
