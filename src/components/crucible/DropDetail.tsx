"use client";

/**
 * Crucible — newsroom-side drop detail pane.
 *
 * Renders the full plaintext (preserves whitespace; we don't render
 * markdown in v1 — the safer default for surface like this is to show
 * exactly what the source typed) and a download button for each
 * attachment. "Mark as read" flips the local flag in IDB.
 */

import { useCallback } from "react";
import { Check, Download, Paperclip } from "lucide-react";

import { Button } from "@/components/ui/button";

import { truncatePubkey } from "@/lib/crucible";
import type { DecryptedAttachment, DecryptedDrop } from "@/lib/crucible";

export function DropDetail({
  drop,
  onMarkRead,
}: {
  drop: DecryptedDrop;
  onMarkRead: (id: string) => Promise<void> | void;
}) {
  const onDownload = useCallback((att: DecryptedAttachment) => {
    // Use the attachment bytes as a Blob so we never re-fetch from IPFS
    // for a drop we've already decrypted.
    const buf = new ArrayBuffer(att.bytes.byteLength);
    new Uint8Array(buf).set(att.bytes);
    const blob = new Blob([buf], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = att.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  return (
    <article className="flex h-full flex-col gap-5 overflow-y-auto p-4 sm:p-6">
      <header className="flex flex-col gap-2 border-b-2 border-foreground pb-4">
        <div className="flex items-center justify-between gap-3">
          <p className="font-mono text-[10px] font-bold uppercase tracking-widest">
            drop · {truncatePubkey(drop.id)}
          </p>
          <Button
            type="button"
            variant={drop.read ? "neutral" : "default"}
            size="sm"
            onClick={() => {
              void onMarkRead(drop.id);
            }}
            disabled={drop.read}
            className="shadow-[var(--shadow-brutal)]"
          >
            <Check className="size-3.5" strokeWidth={2.5} />
            {drop.read ? "Read" : "Mark as read"}
          </Button>
        </div>
        <p className="font-heading text-xl font-black uppercase tracking-tight">
          Anonymous submission
        </p>
        <dl className="grid grid-cols-1 gap-2 font-mono text-[10px] uppercase tracking-widest sm:grid-cols-2">
          <div>
            <dt className="opacity-70">received</dt>
            <dd>{new Date(drop.ts * 1000).toISOString()}</dd>
          </div>
          <div>
            <dt className="opacity-70">ipfs cid</dt>
            <dd className="break-all">{drop.cid}</dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="opacity-70">ephemeral key</dt>
            <dd className="break-all">{drop.ephemeralPubkey}</dd>
          </div>
        </dl>
      </header>

      <section>
        <h2 className="font-mono text-[10px] font-bold uppercase tracking-widest">
          message
        </h2>
        <div className="mt-2 border-2 border-foreground bg-background p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap shadow-[var(--shadow-brutal)]">
          {drop.plaintext || (
            <span className="opacity-50">(empty body)</span>
          )}
        </div>
      </section>

      {drop.attachments && drop.attachments.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="font-mono text-[10px] font-bold uppercase tracking-widest">
            attachments
          </h2>
          <ul className="flex flex-col gap-2">
            {drop.attachments.map((att, i) => (
              <li
                key={i}
                className="flex items-center gap-3 border-2 border-foreground p-3 shadow-[var(--shadow-brutal)]"
              >
                <Paperclip className="size-4 shrink-0" strokeWidth={2.5} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs font-bold">
                    {att.name}
                  </p>
                  <p className="font-mono text-[10px] uppercase tracking-widest opacity-70">
                    {formatBytes(att.size)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="neutral"
                  size="sm"
                  onClick={() => onDownload(att)}
                >
                  <Download className="size-3.5" strokeWidth={2.5} />
                  Download
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
