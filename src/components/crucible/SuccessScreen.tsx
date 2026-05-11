"use client";

/**
 * Crucible — source-side success screen.
 *
 * Shown after a successful submit. The source needs two pieces of state
 * before they leave the page:
 *
 *   1. The **drop ID** — a 64-hex string they (and only they) can quote
 *      to the newsroom for status checks. Same value the newsroom sees.
 *   2. The **Pinata CID** — the IPFS address of the encrypted blob.
 *      Useful if the newsroom needs to fetch directly via a public
 *      gateway in case of relay outage.
 *
 * Crucially: this screen does NOT auto-redirect. The source must click
 * "Submit another" to leave. That gives them all the time they need to
 * copy the ID + CID and write them down somewhere they trust.
 *
 * # No identity required, no persistence
 *
 * The source page never wrote anything to IDB. After the source navigates
 * away, the only state remaining is what they manually copied off this
 * screen. That's the entire point of the design.
 */

import { useCallback, useState } from "react";
import { CheckCircle2, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import type { SubmitResult } from "@/lib/crucible";

export function SuccessScreen({
  result,
  onSubmitAnother,
}: {
  result: SubmitResult;
  onSubmitAnother: () => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <Card className="shadow-[var(--shadow-brutal-xl)]">
        <CardHeader>
          <CardTitle className="font-heading flex items-center gap-3 text-2xl font-black uppercase tracking-tight">
            <CheckCircle2 className="size-8" strokeWidth={2.5} />
            Drop submitted
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="border-2 border-foreground bg-muted p-4 shadow-[var(--shadow-brutal)]">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest">
              save this — do NOT lose it
            </p>
            <p className="mt-1 text-sm leading-relaxed">
              These IDs are the only references that link your encrypted
              submission to the newsroom&apos;s view of it. If you want to
              follow up or confirm receipt, you&apos;ll need them. Aegis does
              not — and cannot — keep a copy for you.
            </p>
          </div>

          <CopyRow
            label="Drop ID"
            value={result.dropId}
            hint="Quote this when contacting the newsroom."
          />
          <CopyRow
            label="IPFS CID"
            value={result.cid}
            hint="The encrypted blob lives at this content address on IPFS."
          />
          <CopyRow
            label="Ephemeral key"
            value={result.ephemeralPubkeyHex}
            hint="The one-shot public key the newsroom derives the decrypt key from."
          />

          <div className="border-2 border-foreground bg-background p-3 shadow-[var(--shadow-brutal)]">
            <p className="font-mono text-[10px] font-bold uppercase tracking-widest">
              broadcast outcome
            </p>
            <ul className="mt-1 font-mono text-xs leading-relaxed">
              {result.publishResults.map((r) => (
                <li key={r.network} className="flex gap-2">
                  <span className="font-bold uppercase">{r.network}</span>
                  <span>{r.ok ? "OK" : "FAILED"}</span>
                  {r.reason ? (
                    <span className="text-muted-foreground">
                      · {r.reason}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>

          <Button
            type="button"
            size="lg"
            onClick={onSubmitAnother}
            className="h-14 text-base shadow-[var(--shadow-brutal-lg)]"
            data-testid="crucible-submit-another"
          >
            Submit another drop
          </Button>
          <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
            your in-memory ephemeral key has been wiped. nothing was saved to this browser.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function CopyRow({
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
        // Fallback for environments without the Clipboard API.
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
      /* swallow — UI shows nothing changed */
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
          size="lg"
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
