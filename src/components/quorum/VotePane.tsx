"use client";

/**
 * Pre-close vote pane. Renders one large brutalist radio card per option
 * plus a submit button. After submit, shows a sealed-ballot acknowledgement
 * (the user can not see / change their own vote thanks to timelock — that's
 * the protocol point, but we still want to communicate "your ballot was
 * sealed and dispatched" clearly).
 *
 * # Why radio cards, not <input type="radio">
 *
 * We want the entire card clickable, brutalist sizing, and a visible
 * shadow-brutal lift. Native radios don't compose well with that. We
 * fall back to a div+button pattern with `role="radio"` / `aria-checked`
 * so screen readers still see a real radio group. The keyboard story is
 * intentionally light (Enter / Space submits the focused card); a full
 * arrow-key navigation can be added if the v1 audience asks.
 */

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";

import type { PollMeta } from "@/lib/quorum";

export function VotePane({
  poll,
  disabled,
  hasVoted,
  mySubmittedAt,
  isSubmitting,
  error,
  onSubmit,
}: {
  poll: PollMeta;
  /** True when the poll is closed or the user otherwise can't vote. */
  disabled: boolean;
  /** True if we've already submitted (UI shows ack instead of form). */
  hasVoted: boolean;
  /** Unix ms of our submit, if any. */
  mySubmittedAt: number | null;
  isSubmitting: boolean;
  error: string | null;
  onSubmit: (optionIndex: number) => Promise<void> | void;
}) {
  const [selected, setSelected] = useState<number | null>(null);

  const submit = useCallback(async () => {
    if (selected === null) return;
    await onSubmit(selected);
  }, [selected, onSubmit]);

  if (hasVoted) {
    return (
      <div className="flex flex-1 flex-col gap-4 bg-background p-4 sm:p-6">
        <div className="border-2 border-foreground p-4 shadow-[var(--shadow-brutal-lg)]">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            ballot sealed
          </p>
          <p className="mt-2 font-heading text-xl font-black uppercase tracking-tight">
            Your vote is timelocked.
          </p>
          <p className="mt-3 max-w-xl text-sm leading-relaxed">
            Your option is encrypted to drand round{" "}
            <span className="font-mono">{poll.drandRound}</span>. Nobody
            (including you, on this device) can recover the choice until the
            close round is signed by the network. Everyone who runs a tally
            after close will see the same result.
          </p>
          {mySubmittedAt ? (
            <p className="mt-3 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              submitted at {formatLocalTime(mySubmittedAt)}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 bg-background p-4 sm:p-6">
      <p className="font-mono text-[11px] uppercase tracking-widest">
        choose one
      </p>
      <ul
        role="radiogroup"
        aria-label="vote options"
        className="flex flex-col gap-3"
      >
        {poll.options.map((label, i) => {
          const active = selected === i;
          return (
            <li key={i}>
              <button
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled || isSubmitting}
                onClick={() => setSelected(i)}
                className={`group flex w-full items-center gap-4 border-2 border-foreground bg-background px-4 py-4 text-left font-heading text-lg font-black uppercase tracking-tight transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50 ${
                  active
                    ? "shadow-[var(--shadow-brutal-xl)] translate-x-[-2px] translate-y-[-2px] bg-muted"
                    : "shadow-[var(--shadow-brutal-lg)] hover:translate-x-[-1px] hover:translate-y-[-1px]"
                }`}
              >
                <span
                  className={`inline-flex h-6 w-6 shrink-0 items-center justify-center border-2 border-foreground ${
                    active ? "bg-foreground" : "bg-background"
                  }`}
                  aria-hidden
                >
                  {active ? (
                    <span className="h-2 w-2 bg-background" />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1 break-words">{label}</span>
                <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  #{i + 1}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p className="font-mono text-xs uppercase tracking-widest">{error}</p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-foreground pt-4">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          ballot will be timelocked to round {poll.drandRound}
        </p>
        <Button
          type="button"
          onClick={() => {
            void submit();
          }}
          disabled={
            disabled || isSubmitting || selected === null
          }
          className="shadow-[var(--shadow-brutal-lg)]"
        >
          {isSubmitting
            ? "Sealing…"
            : selected === null
              ? "Pick an option"
              : "Seal & submit"}
        </Button>
      </div>
    </div>
  );
}

function formatLocalTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
