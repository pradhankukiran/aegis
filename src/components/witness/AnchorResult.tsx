"use client";

/**
 * Result card shown after a successful anchor. Surfaces:
 *
 *   - the SHA-256 hash (monospace, full + copyable)
 *   - the BIP-340 signature (monospace, truncated + copyable)
 *   - per-network status (3 brutalist badges, border-style carries state)
 *   - a shareable proof URL `/witness/<hash>` with copy button
 *
 * Badge palette mirrors `NetworkStatusBadges` so the same brutalist visual
 * language carries across Herald → Witness.
 */
import { useCallback, useMemo, useState } from "react";
import { CheckCircle2, Copy, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

import type { AnchorRecord } from "@/lib/witness";

export function AnchorResult({
  record,
  origin,
}: {
  record: AnchorRecord;
  /**
   * Optional explicit origin (e.g. for tests). Defaults to
   * `window.location.origin`; falls back to relative URL if `window` is
   * absent (SSR render — won't happen in practice because the page is
   * `"use client"`, but the guard is cheap).
   */
  origin?: string;
}) {
  const proofUrl = useMemo(() => {
    const base =
      origin ??
      (typeof window !== "undefined" ? window.location.origin : "");
    return `${base}/witness/${record.hash}`;
  }, [record.hash, origin]);

  const fullyAnchored = useMemo(
    () => record.networkResults.filter((r) => r.ok).length === 3,
    [record.networkResults],
  );

  return (
    <Card className="shadow-[var(--shadow-brutal-xl)]">
      <CardHeader>
        <CardTitle className="font-heading text-2xl font-black uppercase tracking-tight">
          {fullyAnchored ? "Anchored on 3/3 networks" : "Anchor published"}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {record.fileName ? (
          <FileMeta name={record.fileName} size={record.fileSize} />
        ) : null}

        <FieldCopy label="hash (sha-256)" value={record.hash} />
        <FieldCopy
          label="signature (bip-340)"
          value={record.sig}
          displayValue={truncate(record.sig)}
        />
        <FieldCopy
          label="signer (x-only pubkey)"
          value={record.signer}
          displayValue={truncate(record.signer)}
        />

        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
            per-network status
          </p>
          <div className="flex flex-wrap gap-2">
            {record.networkResults.map((r) => (
              <NetworkBadge
                key={r.network}
                label={r.network}
                ok={r.ok}
                reason={r.reason}
              />
            ))}
          </div>
        </div>

        <FieldCopy label="proof url" value={proofUrl} />
      </CardContent>
    </Card>
  );
}

function FileMeta({ name, size }: { name: string; size?: number }) {
  return (
    <div className="border-2 border-foreground bg-muted px-3 py-2">
      <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
        file
      </p>
      <p className="font-mono text-sm font-bold break-all">{name}</p>
      {typeof size === "number" ? (
        <p className="text-muted-foreground mt-0.5 font-mono text-[10px] uppercase tracking-wider">
          {formatBytes(size)}
        </p>
      ) : null}
    </div>
  );
}

function FieldCopy({
  label,
  value,
  displayValue,
}: {
  label: string;
  value: string;
  displayValue?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* nothing else we can do */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [value]);

  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
        {label}
      </p>
      <div className="flex items-center gap-2">
        <p className="flex-1 font-mono text-xs break-all sm:text-sm">
          {displayValue ?? value}
        </p>
        <Button
          type="button"
          variant="neutral"
          size="sm"
          onClick={() => {
            void copy();
          }}
          className="shrink-0 shadow-[var(--shadow-brutal)]"
        >
          {copied ? (
            "Copied"
          ) : (
            <>
              <Copy className="mr-1 size-3" /> Copy
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function NetworkBadge({
  label,
  ok,
  reason,
}: {
  label: string;
  ok: boolean;
  reason?: string;
}) {
  return (
    <span
      data-state={ok ? "ok" : "fail"}
      title={`${label}: ${ok ? "anchored" : (reason ?? "failed")}`}
      className={cn(
        "inline-flex items-center gap-1.5 border-2 border-foreground bg-background px-2 py-1 font-mono text-[10px] uppercase tracking-widest",
        ok
          ? "shadow-[var(--shadow-brutal)]"
          : "border-dashed text-muted-foreground",
      )}
    >
      {ok ? (
        <CheckCircle2 className="size-3" />
      ) : (
        <XCircle className="size-3" />
      )}
      {label}
    </span>
  );
}

function truncate(value: string): string {
  if (value.length <= 24) return value;
  return `${value.slice(0, 16)}…${value.slice(-8)}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
