"use client";

/**
 * Verify-route renderer. Shows everything the user needs to evaluate a
 * proof URL:
 *   - hash + signature + signer + timestamp
 *   - per-network presence with explicit "found / not found / pending"
 *     state
 *   - overall verdict (signature valid AND found on ≥ 1 network) and
 *     "fully anchored" indicator (found on 3 / 3)
 *
 * The component is purely presentational — the hook (`useVerify`) owns the
 * subscription and signature check.
 */
import { useCallback, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  HelpCircle,
  Loader2,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

import type {
  AnchorRecord,
  NetworkVerification,
  Verification,
} from "@/lib/witness";

export function ProofViewer({
  hash,
  verification,
  localRecord,
  isLoading,
  error,
  onRefresh,
}: {
  hash: string;
  verification: Verification | null;
  localRecord: AnchorRecord | null;
  isLoading: boolean;
  error: string | null;
  onRefresh?: () => void;
}) {
  const overall = verification?.overallOk ?? false;
  const fullyAnchored = verification?.fullyAnchored ?? false;

  return (
    <div className="flex flex-col gap-5">
      <VerdictCard
        overall={overall}
        fully={fullyAnchored}
        isLoading={isLoading}
        error={error}
      />

      <Card className="shadow-[var(--shadow-brutal-xl)]">
        <CardHeader>
          <CardTitle className="font-heading text-xl font-black uppercase tracking-tight">
            Anchor details
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {localRecord?.fileName ? (
            <FileMeta name={localRecord.fileName} size={localRecord.fileSize} />
          ) : null}

          <FieldCopy label="hash (sha-256)" value={hash} />
          {localRecord ? (
            <>
              <FieldCopy
                label="signature (bip-340)"
                value={localRecord.sig}
                displayValue={truncate(localRecord.sig)}
              />
              <FieldCopy
                label="signer (x-only pubkey)"
                value={localRecord.signer}
                displayValue={truncate(localRecord.signer)}
              />
              <Field
                label="timestamp"
                value={formatTimestamp(localRecord.ts)}
              />
            </>
          ) : (
            <p className="text-muted-foreground font-mono text-xs">
              {isLoading
                ? "Looking for the anchor across all three networks…"
                : "No local record. The anchor was created on another device."}
            </p>
          )}

          <NetworkRows
            verification={verification}
            isLoading={isLoading}
          />

          {onRefresh ? (
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRefresh}
                disabled={isLoading}
                className="shadow-[var(--shadow-brutal)]"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="mr-1 size-3 animate-spin" /> Refreshing
                  </>
                ) : (
                  "Re-verify"
                )}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function VerdictCard({
  overall,
  fully,
  isLoading,
  error,
}: {
  overall: boolean;
  fully: boolean;
  isLoading: boolean;
  error: string | null;
}) {
  let title: string;
  let body: string;
  if (error) {
    title = "Verification error";
    body = error;
  } else if (fully) {
    title = "Verified on 3 / 3 networks";
    body =
      "Signature is valid and the anchor is present on Nostr, Matrix, and SSB.";
  } else if (overall) {
    title = "Verified";
    body =
      "Signature is valid and the anchor is present on at least one network.";
  } else if (isLoading) {
    title = "Verifying…";
    body =
      "Checking the signature and querying every connected network for this hash.";
  } else {
    title = "Not yet anchored";
    body =
      "We could not find a matching anchor on any connected network within the timeout window.";
  }
  return (
    <Card
      className={cn(
        "shadow-[var(--shadow-brutal-xl)]",
        overall ? "" : "border-dashed",
      )}
    >
      <CardHeader>
        <CardTitle className="font-heading flex items-center gap-2 text-2xl font-black uppercase tracking-tight">
          {error ? (
            <AlertTriangle className="size-6" />
          ) : fully ? (
            <CheckCircle2 className="size-6" />
          ) : overall ? (
            <CheckCircle2 className="size-6" />
          ) : isLoading ? (
            <Loader2 className="size-6 animate-spin" />
          ) : (
            <HelpCircle className="size-6" />
          )}
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm leading-relaxed">{body}</p>
      </CardContent>
    </Card>
  );
}

function NetworkRows({
  verification,
  isLoading,
}: {
  verification: Verification | null;
  isLoading: boolean;
}) {
  const fallback: NetworkVerification[] = [
    { network: "nostr", found: false },
    { network: "matrix", found: false },
    { network: "ssb", found: false },
  ];
  const rows = verification?.networks ?? fallback;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
        per-network presence
      </p>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li
            key={row.network}
            className="flex items-center justify-between border-2 border-foreground bg-background px-3 py-2"
          >
            <span className="font-mono text-xs font-bold uppercase tracking-widest">
              {row.network}
            </span>
            <NetworkVerdict row={row} isLoading={isLoading} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function NetworkVerdict({
  row,
  isLoading,
}: {
  row: NetworkVerification;
  isLoading: boolean;
}) {
  if (!row.found) {
    if (isLoading) {
      return (
        <span className="text-muted-foreground inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest">
          <Loader2 className="size-3 animate-spin" /> Pending
        </span>
      );
    }
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 border-2 border-dashed border-foreground bg-background px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest">
        <XCircle className="size-3" /> Not found
      </span>
    );
  }
  if (row.signatureValid) {
    return (
      <span className="inline-flex items-center gap-1 border-2 border-foreground bg-background px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest shadow-[var(--shadow-brutal)]">
        <CheckCircle2 className="size-3" /> Verified
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 border-2 border-foreground bg-background px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest">
      <AlertTriangle className="size-3" /> Signature invalid
    </span>
  );
}

/* ---------- subcomponents shared with AnchorResult ---------- */

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

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
        {label}
      </p>
      <p className="font-mono text-xs break-all sm:text-sm">{value}</p>
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
          variant="outline"
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

function formatTimestamp(unixSeconds: number): string {
  const dt = new Date(unixSeconds * 1000);
  return `${dt.toISOString()} (${unixSeconds})`;
}
