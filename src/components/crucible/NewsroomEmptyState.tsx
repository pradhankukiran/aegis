"use client";

/**
 * Crucible — newsroom-side empty state.
 *
 * Shown when no drops have ever been received. The action that gets the
 * newsroom unblocked is: share their pubkey with sources. We surface a
 * one-click "copy pubkey" button so they can immediately put it into
 * their bio / website footer / poster.
 *
 * Both canonical forms are exposed (66-char compressed AND 64-char
 * x-only) because some sources will paste from one Aegis feature where
 * the other surfaces an x-only form. The newsroom subscriber accepts
 * both, so either one works.
 */

import { useCallback, useState } from "react";
import { Copy, Inbox } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { pubkeyHex } from "@/lib/identity";
import type { Identity } from "@/lib/identity";

export function NewsroomEmptyState({ identity }: { identity: Identity }) {
  const compressed = pubkeyHex(identity);
  const xOnly = compressed.length === 66 ? compressed.slice(2) : compressed;

  return (
    <div className="flex flex-1 items-center justify-center p-6 sm:p-12">
      <Card className="w-full max-w-2xl shadow-[var(--shadow-brutal-xl)]">
        <CardHeader>
          <CardTitle className="font-heading flex items-center gap-3 text-2xl font-black uppercase tracking-tight">
            <Inbox className="size-7" strokeWidth={2.5} />
            No drops yet
          </CardTitle>
          <p className="text-sm leading-relaxed">
            Share one of your public keys with sources. They paste it into
            the drop form, encrypt their submission to it, and announce a
            pointer across all three Aegis networks. The next time you sign
            in here, the dashboard fetches and decrypts every drop addressed
            to you.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <CopyBlock
            label="Compressed (66 hex)"
            value={compressed}
            hint="Standard SEC1-compressed secp256k1 form."
          />
          <CopyBlock
            label="X-only (64 hex)"
            value={xOnly}
            hint="Nostr-canonical x-only form. Most Aegis features surface this."
          />
          <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
            keep this tab open or sign back in periodically — drops are pulled live from the three networks.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function CopyBlock({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const ta = document.createElement("textarea");
        ta.value = value;
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } catch {
          /* nothing we can do */
        }
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* swallow */
    }
  }, [value]);
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-[10px] font-bold uppercase tracking-widest">
        {label}
      </p>
      <div className="flex items-stretch gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto border-2 border-foreground bg-background p-3 font-mono text-xs leading-relaxed shadow-[var(--shadow-brutal)]">
          {value}
        </code>
        <Button
          type="button"
          variant="neutral"
          onClick={() => {
            void copy();
          }}
          className="shrink-0 shadow-[var(--shadow-brutal)]"
        >
          <Copy className="size-4" strokeWidth={2.5} />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {hint ? (
        <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
