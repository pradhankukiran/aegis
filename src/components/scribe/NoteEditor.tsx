"use client";

/**
 * Center column: the editor. Title input + plain Textarea for the body +
 * a status footer ("saved Ns ago" / "saving…" / "unsaved changes").
 *
 * Plain Textarea is intentional for v1 — Markdown syntax highlighting is a
 * cosmetic upgrade we can layer in later via prism / shiki, but it adds
 * weight to the bundle and isn't on the critical path for the encrypted-
 * notes feature itself.
 *
 * Autosave: Cmd/Ctrl+S triggers an immediate save. We don't run a debounced
 * autosave in v1 — explicit-save matches the "every save is a feed entry"
 * model and avoids spamming SSB during fast typing. The dirty indicator
 * surfaces unsaved state.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { formatRelative } from "@/lib/scribe";
import type { Note, NoteDraft } from "@/lib/scribe";

export function NoteEditor({
  note,
  draft,
  setDraft,
  save,
  saving,
  isDirty,
  loading,
  error,
  disabled,
}: {
  note: Note | null;
  draft: NoteDraft | null;
  setDraft: (partial: Partial<NoteDraft>) => void;
  save: () => Promise<Note | null>;
  saving: boolean;
  isDirty: boolean;
  loading: boolean;
  error: string | null;
  disabled?: boolean;
}) {
  // Re-render every ~5s to keep the relative timestamp honest. The hook
  // produces a stable string for the same minute, so the cost is a single
  // setState every tick — negligible.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const handleSave = useCallback(() => {
    if (!isDirty || saving) return;
    void save();
  }, [isDirty, saving, save]);

  // Cmd/Ctrl+S to save. We bind to the editor's keydown rather than window
  // so background pages don't steal a global save shortcut.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const isSave = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s";
      if (!isSave) return;
      e.preventDefault();
      handleSave();
    },
    [handleSave],
  );

  const statusText = useMemo<string>(() => {
    if (loading) return "Loading…";
    if (saving) return "Saving…";
    if (isDirty) return "Unsaved changes";
    if (note) return `Saved ${formatRelative(note.updatedAt)}`;
    return "";
  }, [loading, saving, isDirty, note]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-muted-foreground font-mono text-sm uppercase tracking-wider">
          loading…
        </p>
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-muted-foreground font-mono text-sm uppercase tracking-wider">
          select a note from the list
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col" onKeyDown={onKeyDown}>
      <div className="flex flex-col gap-3 border-b-2 border-foreground p-4">
        <Input
          value={draft.title}
          onChange={(e) => setDraft({ title: e.target.value })}
          placeholder="Untitled note"
          disabled={disabled}
          spellCheck={false}
          className="border-2 font-bold text-base"
        />
        {error ? (
          <p className="font-mono text-xs text-foreground">{error}</p>
        ) : null}
      </div>
      <div className="flex-1 overflow-hidden p-4">
        <Textarea
          value={draft.content}
          onChange={(e) => setDraft({ content: e.target.value })}
          placeholder="Start writing… Markdown is welcome."
          disabled={disabled}
          spellCheck={false}
          className="h-full min-h-[300px] resize-none font-mono text-sm leading-relaxed"
        />
      </div>
      <div className="flex items-center justify-between gap-3 border-t-2 border-foreground bg-background px-4 py-3 text-xs">
        <span className="text-muted-foreground font-mono uppercase tracking-wider">
          {statusText}
        </span>
        <div className="flex items-center gap-2">
          {note ? (
            <span className="text-muted-foreground font-mono text-[10px] uppercase tracking-wider">
              id {note.id.slice(0, 8)}
            </span>
          ) : null}
          <Button
            type="button"
            onClick={handleSave}
            disabled={!isDirty || saving || disabled}
            size="sm"
            className="font-bold uppercase tracking-wide"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}
