"use client";

/**
 * Left rail: list of notes. Each row shows the title (plaintext, from the
 * `Note` row's metadata — never the envelope), a relative timestamp, and a
 * small "shared" badge if `sharedRoomId` is set.
 *
 * Clicking a row selects it via `onSelect`. The "+ New" CTA sits above the
 * list so it's always reachable.
 */

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { formatRelative } from "@/lib/scribe";
import type { Note } from "@/lib/scribe";

export function NoteList({
  notes,
  selectedId,
  onSelect,
  onCreate,
  creating,
}: {
  notes: Note[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  creating: boolean;
}) {
  return (
    <div className="flex flex-col border-r-2 border-foreground">
      <div className="border-b-2 border-foreground bg-background p-3">
        <Button
          type="button"
          onClick={onCreate}
          disabled={creating}
          className="w-full font-bold uppercase tracking-wide"
        >
          {creating ? "Creating…" : "+ New note"}
        </Button>
      </div>
      {notes.length === 0 ? (
        <div className="text-muted-foreground p-4 text-sm">
          <p className="font-mono text-xs uppercase tracking-wider">
            no notes yet
          </p>
          <p className="mt-2 leading-relaxed">
            Press “New note” to mint your first one.
          </p>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto">
          {notes.map((n) => {
            const isSelected = n.id === selectedId;
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => onSelect(n.id)}
                  className={cn(
                    "w-full border-b-2 border-foreground px-4 py-3 text-left transition-colors",
                    isSelected
                      ? "bg-foreground text-background"
                      : "bg-background hover:bg-muted",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate font-bold">{n.title}</div>
                    {n.sharedRoomId ? (
                      <span
                        className={cn(
                          "shrink-0 border px-1 font-mono text-[9px] uppercase tracking-wider",
                          isSelected
                            ? "border-background text-background"
                            : "border-foreground text-foreground",
                        )}
                      >
                        shared
                      </span>
                    ) : null}
                  </div>
                  <div
                    className={cn(
                      "mt-0.5 font-mono text-[10px] uppercase tracking-wider",
                      isSelected ? "text-background/70" : "text-muted-foreground",
                    )}
                  >
                    {formatRelative(n.updatedAt)}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
