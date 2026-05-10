"use client";

/**
 * Brutalist form for creating a new poll. Fields:
 *
 *   - Title (required, trimmed).
 *   - Options: 2-10 dynamic inputs with Add/Remove buttons.
 *   - Voter list: textarea of pubkey hex (one per line, blank = open poll).
 *   - Close datetime: `<input type="datetime-local">` (the most universal
 *     picker without bringing in a calendar component). We convert the
 *     value back to Unix ms before handing off.
 *
 * The form does not call the drand projection itself — that's the hook's
 * job. We just package the raw values into `CreatePollInput` and let the
 * hook compute `drandRound` from `closeUnix`.
 */

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { isValidPubkeyHex, normalizePubkey } from "@/lib/quorum";
import type { CreatePollInput, PollMeta } from "@/lib/quorum";

const MAX_OPTIONS = 10;
const MIN_OPTIONS = 2;

export function CreatePollForm({
  onCreate,
  isWorking,
  hookError,
  disabled,
}: {
  onCreate: (input: CreatePollInput) => Promise<PollMeta>;
  isWorking: boolean;
  /** Error from the parent hook (e.g. publish failure). */
  hookError: string | null;
  /** True if transport / identity isn't ready yet. */
  disabled: boolean;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [votersRaw, setVotersRaw] = useState("");
  const [closeLocal, setCloseLocal] = useState<string>(() => defaultCloseLocal());
  const [error, setError] = useState<string | null>(null);

  /** Parse the textarea into deduped + normalized pubkeys, plus error lines. */
  const { voters, voterErrors } = useMemo(() => {
    const lines = votersRaw.split(/\r?\n/);
    const out: string[] = [];
    const errs: string[] = [];
    const seen = new Set<string>();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      if (!isValidPubkeyHex(t)) {
        errs.push(t.slice(0, 24) + (t.length > 24 ? "…" : ""));
        continue;
      }
      const n = normalizePubkey(t);
      if (!seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return { voters: out, voterErrors: errs };
  }, [votersRaw]);

  const setOptionAt = useCallback((i: number, value: string) => {
    setOptions((prev) => {
      const next = prev.slice();
      next[i] = value;
      return next;
    });
  }, []);

  const addOption = useCallback(() => {
    setOptions((prev) => (prev.length < MAX_OPTIONS ? [...prev, ""] : prev));
  }, []);

  const removeOption = useCallback((i: number) => {
    setOptions((prev) =>
      prev.length > MIN_OPTIONS ? prev.filter((_, idx) => idx !== i) : prev,
    );
  }, []);

  const optionsValid = options.filter((o) => o.trim()).length >= MIN_OPTIONS;
  const titleValid = title.trim().length > 0;
  const closeUnix = useMemo<number | null>(() => {
    if (!closeLocal) return null;
    const t = Date.parse(closeLocal);
    if (!Number.isFinite(t)) return null;
    return t;
  }, [closeLocal]);
  // closeUnix-presence check only — the in-future check happens inside
  // `submit` (calling Date.now() during render is impure per the
  // react-hooks/purity rule).
  const closeHasValue = closeUnix !== null;

  const submit = useCallback(async () => {
    if (!titleValid) {
      setError("title required");
      return;
    }
    if (!optionsValid) {
      setError(`add at least ${MIN_OPTIONS} options`);
      return;
    }
    if (closeUnix === null) {
      setError("pick a valid close date/time");
      return;
    }
    if (closeUnix <= Date.now()) {
      setError("close time must be in the future");
      return;
    }
    if (voterErrors.length > 0) {
      setError(`fix invalid voter pubkey: ${voterErrors[0]}`);
      return;
    }
    setError(null);
    try {
      const created = await onCreate({
        title,
        options,
        voters,
        closeUnix,
      });
      router.push(`/quorum/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create");
    }
  }, [
    titleValid,
    optionsValid,
    voterErrors,
    onCreate,
    title,
    options,
    voters,
    closeUnix,
    router,
  ]);

  const formDisabled = disabled || isWorking;

  return (
    <div className="flex flex-1 flex-col gap-6 bg-background p-4 sm:p-6">
      <Field label="title">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="what's the question?"
          disabled={formDisabled}
          spellCheck={false}
          className="font-mono"
          maxLength={120}
        />
      </Field>

      <Field
        label="options"
        hint={`${options.filter((o) => o.trim()).length}/${MAX_OPTIONS}`}
      >
        <ul className="flex flex-col gap-2">
          {options.map((value, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                #{i + 1}
              </span>
              <Input
                value={value}
                onChange={(e) => setOptionAt(i, e.target.value)}
                placeholder={`option ${i + 1}`}
                disabled={formDisabled}
                spellCheck={false}
                className="font-mono flex-1"
                maxLength={120}
              />
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => removeOption(i)}
                disabled={formDisabled || options.length <= MIN_OPTIONS}
                aria-label={`remove option ${i + 1}`}
              >
                remove
              </Button>
            </li>
          ))}
        </ul>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={addOption}
          disabled={formDisabled || options.length >= MAX_OPTIONS}
          className="mt-2 shadow-[var(--shadow-brutal)]"
        >
          + add option
        </Button>
      </Field>

      <Field
        label="voter list"
        hint={
          voters.length === 0
            ? "open · anyone may vote"
            : `${voters.length} voter${voters.length === 1 ? "" : "s"}`
        }
      >
        <Textarea
          value={votersRaw}
          onChange={(e) => setVotersRaw(e.target.value)}
          placeholder={
            "one pubkey per line — leave blank for an open poll\nabcdef0123… (64 or 66 hex chars)"
          }
          disabled={formDisabled}
          spellCheck={false}
          className="min-h-32 font-mono text-xs"
        />
        {voterErrors.length > 0 ? (
          <p className="mt-1 font-mono text-[10px] uppercase tracking-widest">
            {voterErrors.length} invalid pubkey line
            {voterErrors.length === 1 ? "" : "s"} — first: {voterErrors[0]}
          </p>
        ) : null}
      </Field>

      <Field label="close at">
        <Input
          type="datetime-local"
          value={closeLocal}
          onChange={(e) => setCloseLocal(e.target.value)}
          disabled={formDisabled}
          className="font-mono"
        />
      </Field>

      {(error ?? hookError) ? (
        <p className="font-mono text-xs uppercase tracking-widest">
          {error ?? hookError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-3 border-t-2 border-foreground pt-4">
        <Button
          type="button"
          onClick={() => {
            void submit();
          }}
          disabled={
            formDisabled || !titleValid || !optionsValid || !closeHasValue
          }
          className="shadow-[var(--shadow-brutal-lg)]"
        >
          {isWorking ? "Creating…" : "Create poll"}
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <label className="font-mono text-[10px] uppercase tracking-widest">
          {label}
        </label>
        {hint ? (
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** Default close-at value: 24 hours from now, in `<input datetime-local>` form. */
function defaultCloseLocal(): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
