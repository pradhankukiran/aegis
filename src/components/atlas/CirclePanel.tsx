"use client";

/**
 * Right rail: list of trusted circle members with truncated pubkey,
 * nickname (if set), and a remove button. "Add member" affordance is
 * delegated to the parent so the dialog can be hoisted out of the list
 * and avoid re-renders on every IDB mutation.
 *
 * Each row also surfaces "last seen" pulled from the live fixes-by-member
 * map — useful at-a-glance feedback that the encrypted DM pipeline is
 * actually delivering.
 */

import { Button } from "@/components/ui/button";

import { truncatePubkey } from "@/lib/atlas";
import type { CircleMember, ReceivedFix } from "@/lib/atlas";

export function CirclePanel({
  members,
  fixesByMember,
  onRemove,
  onAdd,
}: {
  members: CircleMember[];
  fixesByMember: Record<string, ReceivedFix>;
  onRemove: (pubkey: string) => Promise<void> | void;
  onAdd: React.ReactNode;
}) {
  return (
    <aside className="flex h-full flex-col border-l-2 border-foreground bg-background">
      <div className="flex items-center justify-between border-b-2 border-foreground p-3">
        <p className="font-mono text-[10px] uppercase tracking-widest">
          circle
        </p>
        {onAdd}
      </div>
      {members.length === 0 ? (
        <div className="flex flex-1 items-start p-4 text-sm">
          <div>
            <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
              no members
            </p>
            <p className="mt-2 leading-relaxed">
              Add the pubkey of someone you trust to share your live location
              with them.
            </p>
          </div>
        </div>
      ) : (
        <ul className="flex-1 overflow-y-auto">
          {members.map((m) => {
            const fix = fixesByMember[m.pubkey] ?? null;
            return (
              <li
                key={m.pubkey}
                className="border-b-2 border-foreground px-3 py-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-sm font-bold">
                      {m.nickname?.trim() ?? truncatePubkey(m.pubkey)}
                    </div>
                    {m.nickname?.trim() ? (
                      <div className="truncate font-mono text-[10px] text-muted-foreground">
                        {truncatePubkey(m.pubkey)}
                      </div>
                    ) : null}
                    <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                      {fix
                        ? `last seen ${formatRelative(fix.ts)}`
                        : "no fix yet"}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant="neutral"
                    onClick={() => {
                      void onRemove(m.pubkey);
                    }}
                    title="Remove from circle"
                  >
                    remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

/** Compact relative-time string. Matches Herald's `ConversationList.formatRelative`. */
function formatRelative(ts: number): string {
  const dt = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return dt.toISOString().slice(0, 10);
}
