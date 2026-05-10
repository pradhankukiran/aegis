"use client";

/**
 * Crucible — newsroom-side dashboard shell.
 *
 * Two-column layout (single column on small screens):
 *
 *   left:  drop list. Filter controls live above. Renders `DropListItem`
 *          rows.
 *   right: drop detail pane. Renders `DropDetail` for the selected row,
 *          or a placeholder when nothing is picked.
 *
 * The component is stateless w.r.t. the IDB pipeline — the page owns the
 * `useDrops()` + `useDropReceiver(...)` hooks. We just consume the
 * already-loaded list + an `onSelect` / `onMarkRead` pair.
 *
 * Filter controls in v1:
 *   - All / Unread toggle.
 *   - Search by drop id substring.
 */

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import type { DecryptedDrop } from "@/lib/crucible";

import { DropDetail } from "./DropDetail";
import { DropListItem } from "./DropListItem";

export function NewsroomDashboard({
  drops,
  onMarkRead,
}: {
  drops: DecryptedDrop[];
  onMarkRead: (id: string) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    drops[0]?.id ?? null,
  );
  const [search, setSearch] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return drops.filter((d) => {
      if (unreadOnly && d.read) return false;
      if (q && !d.id.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [drops, search, unreadOnly]);

  // Auto-pick the first filtered row if the current selection has been
  // filtered out. This keeps the detail pane meaningful as the filter
  // changes without the user having to click again.
  const effectiveSelectedId =
    filtered.find((d) => d.id === selectedId)?.id ?? filtered[0]?.id ?? null;
  const selectedDrop = filtered.find((d) => d.id === effectiveSelectedId) ?? null;

  return (
    <div className="grid flex-1 grid-cols-1 overflow-hidden md:grid-cols-[340px_1fr]">
      <aside className="flex flex-col overflow-hidden border-r-2 border-foreground">
        <div className="flex flex-col gap-2 border-b-2 border-foreground p-3">
          <Input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search drop id…"
            className="font-mono text-xs"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant={unreadOnly ? "default" : "outline"}
              size="xs"
              onClick={() => setUnreadOnly((v) => !v)}
            >
              {unreadOnly ? "Showing unread" : "Show unread only"}
            </Button>
            <span className="ml-auto font-mono text-[10px] uppercase tracking-widest opacity-70">
              {filtered.length} / {drops.length}
            </span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="p-4 text-center font-mono text-[10px] uppercase tracking-widest opacity-70">
              {drops.length === 0 ? "no drops yet" : "no rows match filter"}
            </div>
          ) : (
            filtered.map((d) => (
              <DropListItem
                key={d.id}
                drop={d}
                selected={d.id === effectiveSelectedId}
                onSelect={(id) => setSelectedId(id)}
              />
            ))
          )}
        </div>
      </aside>
      <section className="overflow-hidden">
        {selectedDrop ? (
          <DropDetail drop={selectedDrop} onMarkRead={onMarkRead} />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center">
            <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
              select a drop to view
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
