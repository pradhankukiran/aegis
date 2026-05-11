"use client";

/**
 * Dialog form for creating a new beacon. Inputs:
 *
 *   - title             plaintext label shown in the list.
 *   - message body      the plaintext to seal in the envelope.
 *   - deadline (local)  HTML datetime-local input → converted to Unix.
 *                       Defaults to +7 days from now.
 *   - grace hours       small number input → defaults to 1h (3600 s).
 *
 * Submission triggers the full create flow: encrypt → upload to Pinata →
 * persist locally → publish timelock-encrypted release events on every
 * connected network. The hook handles error surfacing.
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import type { NewBeaconInput } from "@/lib/beacon";

const DEFAULT_GRACE_HOURS = 1;
const DEFAULT_DEADLINE_OFFSET_DAYS = 7;

export function CreateBeaconForm({
  onCreate,
  isWorking,
}: {
  onCreate: (input: NewBeaconInput) => Promise<void>;
  isWorking: boolean;
}) {
  const [open, setOpen] = useState(false);

  const defaultDeadlineLocal = useMemo<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() + DEFAULT_DEADLINE_OFFSET_DAYS);
    return toLocalInputValue(d);
  }, []);

  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [deadlineLocal, setDeadlineLocal] = useState<string>(defaultDeadlineLocal);
  const [graceHours, setGraceHours] = useState<string>(
    String(DEFAULT_GRACE_HOURS),
  );
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setTitle("");
    setMessage("");
    setDeadlineLocal(defaultDeadlineLocal);
    setGraceHours(String(DEFAULT_GRACE_HOURS));
    setError(null);
  }, [defaultDeadlineLocal]);

  const submit = useCallback(async () => {
    setError(null);
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Title is required.");
      return;
    }
    if (!message.trim()) {
      setError("Message body is required.");
      return;
    }
    const deadlineMs = parseLocalInputValue(deadlineLocal);
    if (deadlineMs === null) {
      setError("Pick a valid deadline.");
      return;
    }
    const nowMs = Date.now();
    if (deadlineMs <= nowMs) {
      setError("Deadline must be in the future.");
      return;
    }
    const grace = Number.parseFloat(graceHours);
    if (!Number.isFinite(grace) || grace < 0) {
      setError("Grace hours must be a non-negative number.");
      return;
    }
    try {
      await onCreate({
        title: trimmedTitle,
        message,
        deadlineUnix: Math.floor(deadlineMs / 1000),
        graceSeconds: Math.round(grace * 3600),
      });
      reset();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create beacon.");
    }
  }, [title, message, deadlineLocal, graceHours, onCreate, reset]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="neutral"
          className="shadow-[var(--shadow-brutal)]"
        >
          + New beacon
        </Button>
      </DialogTrigger>
      <DialogContent className="border-2 border-foreground rounded-none shadow-[var(--shadow-brutal-lg)] max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-heading text-lg font-black uppercase tracking-tight">
            New beacon
          </DialogTitle>
          <DialogDescription>
            Pre-encode a message that fires across all three networks if you
            don&rsquo;t check in before the deadline.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="beacon-title" className="font-mono text-[10px] uppercase tracking-widest">
              Title
            </Label>
            <Input
              id="beacon-title"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setError(null);
              }}
              placeholder="e.g. press disclosure"
              disabled={isWorking}
              className="font-mono text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="beacon-message" className="font-mono text-[10px] uppercase tracking-widest">
              Message body
            </Label>
            <Textarea
              id="beacon-message"
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                setError(null);
              }}
              placeholder="Plaintext to seal and broadcast on fire."
              disabled={isWorking}
              spellCheck={false}
              className="min-h-[140px] resize-none font-mono text-sm leading-relaxed"
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="beacon-deadline"
                className="font-mono text-[10px] uppercase tracking-widest"
              >
                Deadline (local)
              </Label>
              <Input
                id="beacon-deadline"
                type="datetime-local"
                value={deadlineLocal}
                onChange={(e) => {
                  setDeadlineLocal(e.target.value);
                  setError(null);
                }}
                disabled={isWorking}
                className="font-mono text-sm"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="beacon-grace"
                className="font-mono text-[10px] uppercase tracking-widest"
              >
                Grace (hours)
              </Label>
              <Input
                id="beacon-grace"
                type="number"
                min={0}
                step={0.5}
                value={graceHours}
                onChange={(e) => {
                  setGraceHours(e.target.value);
                  setError(null);
                }}
                disabled={isWorking}
                className="font-mono text-sm"
              />
            </div>
          </div>
          {error ? (
            <p className="font-mono text-xs text-foreground">{error}</p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="neutral"
            disabled={isWorking}
            onClick={() => {
              setOpen(false);
              reset();
            }}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={isWorking}
            onClick={() => {
              void submit();
            }}
            className="shadow-[var(--shadow-brutal)]"
          >
            {isWorking ? "Sealing…" : "Create beacon"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* datetime-local helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Convert a Date into the `YYYY-MM-DDTHH:MM` shape required by
 * `<input type="datetime-local">`. The input's interpretation of the
 * string is "local time, no zone offset" — perfect for the user-facing
 * deadline picker.
 */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/**
 * Parse a `<input type="datetime-local">` value back to Unix milliseconds.
 * Returns null on malformed input. We rely on `Date`'s own parser because
 * the input always emits the canonical form when the user picks a date.
 */
function parseLocalInputValue(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return ms;
}
