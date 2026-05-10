"use client";

/**
 * Voter-eligibility badge for a poll, surfaced near the VotePane.
 *
 * Four states:
 *   "eligible"     — voter is on the whitelist (or the poll is open) AND
 *                    has not yet submitted.
 *   "already-voted" — voter has submitted a ballot. The submit pane should
 *                    disable while still surfacing this badge for clarity.
 *   "not-listed"   — poll has a whitelist and the voter's pubkey is not
 *                    on it. VotePane disables submission.
 *   "closed"       — poll close has passed. VotePane shows TallyView.
 *
 * Border-style + monospace label per the brutalist conventions.
 */

export type EligibilityState =
  | "eligible"
  | "already-voted"
  | "not-listed"
  | "closed";

export function EligibilityBadge({ state }: { state: EligibilityState }) {
  const { label, border } = describe(state);
  return (
    <span
      className={`inline-flex items-center gap-1 border-2 border-foreground bg-background px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${border}`}
    >
      {label}
    </span>
  );
}

function describe(state: EligibilityState): {
  label: string;
  border: string;
} {
  switch (state) {
    case "eligible":
      return { label: "you can vote", border: "" };
    case "already-voted":
      return { label: "ballot sealed", border: "border-dashed" };
    case "not-listed":
      return { label: "not on voter list", border: "border-dotted" };
    case "closed":
      return { label: "closed", border: "border-double" };
  }
}
