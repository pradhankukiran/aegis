"use client";

/**
 * Left rail: list of beacons. Each card surfaces the title, the deadline
 * (formatted as a short ISO label), and the status badge. Selected card
 * inverts to the brutalist filled-black variant.
 *
 * Sort order is "soonest deadline first" — that matches the storage layer
 * (`loadBeacons` sorts asc by `deadlineUnix`).
 */
import { cn } from "@/lib/utils";

import { formatTimestamp } from "@/lib/beacon";
import type { Beacon } from "@/lib/beacon";

import { StatusBadge } from "./StatusBadge";

export function BeaconList({
  beacons,
  selectedId,
  onSelect,
  onCreate,
  creating,
}: {
  beacons: Beacon[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  creating: boolean;
}) {
  return (
    <div className="flex flex-col border-r-2 border-foreground">
      <div className="border-b-2 border-foreground bg-background p-3">
        <button
          type="button"
          onClick={onCreate}
          disabled={creating}
          className={cn(
            "w-full border-2 border-foreground bg-foreground px-3 py-2 text-sm font-bold uppercase tracking-wide text-background transition-transform",
            "hover:translate-x-0.5 hover:translate-y-0.5",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "shadow-[var(--shadow-brutal)]",
          )}
        >
          {creating ? "Creating…" : "+ New beacon"}
        </button>
      </div>
      {beacons.length === 0 ? (
        <div className="text-muted-foreground p-4 text-sm">
          <p className="font-mono text-xs uppercase tracking-wider">
            no beacons yet
          </p>
          <p className="mt-2 leading-relaxed">
            Press &ldquo;New beacon&rdquo; to mint your first dead-man&rsquo;s
            broadcast.
          </p>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto">
          {beacons.map((b) => {
            const isSelected = b.id === selectedId;
            return (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => onSelect(b.id)}
                  className={cn(
                    "w-full border-b-2 border-foreground px-4 py-3 text-left transition-colors",
                    isSelected
                      ? "bg-foreground text-background"
                      : "bg-background hover:bg-muted",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate font-bold">{b.title}</div>
                    <StatusBadge status={b.status} />
                  </div>
                  <div
                    className={cn(
                      "mt-1 font-mono text-[10px] uppercase tracking-wider",
                      isSelected
                        ? "text-background/70"
                        : "text-muted-foreground",
                    )}
                  >
                    fires {formatTimestamp(b.deadlineUnix)}
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
