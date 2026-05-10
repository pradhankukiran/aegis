"use client";

/**
 * Post-close tally rendering. Plain rectangles with brutalist shadow —
 * no chart library. Each option gets:
 *
 *   - Label (the option text).
 *   - Bar rectangle whose width is `count / maxCount`.
 *   - Monospace count + percent next to the bar.
 *
 * Empty tally (no revealed ballots) surfaces an explicit "no ballots
 * revealed" state with the failed-count detail so the user understands
 * the difference between "nobody voted" and "ballots arrived but none
 * decrypted" (which would be a protocol-level bug worth investigating).
 */

import type { PollMeta, Tally } from "@/lib/quorum";

export function TallyView({
  poll,
  tally,
}: {
  poll: PollMeta;
  tally: Tally | null;
}) {
  const counts = tally?.counts ?? new Array(poll.options.length).fill(0);
  const max = Math.max(1, ...counts);
  const revealed = tally?.revealed ?? 0;
  const failed = tally?.failed ?? 0;
  const total = tally?.totalBallots ?? 0;
  const empty = revealed === 0;

  return (
    <div className="flex flex-1 flex-col gap-4 bg-background p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b-2 border-foreground pb-3">
        <h3 className="font-heading text-lg font-black uppercase tracking-tight">
          Tally
        </h3>
        <p className="font-mono text-[11px] uppercase tracking-widest">
          {total} received
          <span className="text-muted-foreground">
            {" · "}
            {revealed} revealed
          </span>
          {failed > 0 ? (
            <span className="text-muted-foreground">
              {" · "}
              {failed} dropped
            </span>
          ) : null}
        </p>
      </div>
      {empty ? (
        <p className="font-mono text-sm uppercase tracking-widest">
          no ballots revealed
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {poll.options.map((label, i) => {
            const count = counts[i] ?? 0;
            const pct = revealed > 0 ? (count / revealed) * 100 : 0;
            const width = (count / max) * 100;
            return (
              <li
                key={i}
                className="flex flex-col gap-1 border-2 border-foreground bg-background p-3 shadow-[var(--shadow-brutal-lg)]"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-heading text-base font-black uppercase tracking-tight">
                    {label}
                  </span>
                  <span className="font-mono text-xs uppercase tracking-widest">
                    {count.toString().padStart(2, " ")}
                    <span className="text-muted-foreground">
                      {" · "}
                      {pct.toFixed(1).padStart(5, " ")}%
                    </span>
                  </span>
                </div>
                <div className="relative h-5 w-full border-2 border-foreground bg-muted">
                  <div
                    className="h-full bg-foreground"
                    style={{ width: `${width}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
