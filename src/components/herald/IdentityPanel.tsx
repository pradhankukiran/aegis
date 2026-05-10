"use client";

/**
 * Full-page CTA shown before the user has an Aegis identity. After
 * generation, displays the truncated pubkey + Copy + Export buttons and
 * a warning to back the key up.
 *
 * Stays on the page until an identity exists (after generation, the parent
 * unmounts this component and renders the chat layout).
 */
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { exportIdentity, pubkeyHex } from "@/lib/identity";
import type { Identity } from "@/lib/identity";

import { truncatePubkey } from "@/lib/herald";

export function IdentityPanel({
  identity,
  onGenerate,
}: {
  identity: Identity | null;
  onGenerate: () => Promise<Identity>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await onGenerate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate.");
    } finally {
      setBusy(false);
    }
  }, [onGenerate]);

  const copy = useCallback(async () => {
    if (!identity) return;
    try {
      await navigator.clipboard.writeText(pubkeyHex(identity));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Older browsers / strict permissions: fall back to a manual input.
      const ta = document.createElement("textarea");
      ta.value = pubkeyHex(identity);
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* nothing else we can do */
      }
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [identity]);

  const exportKey = useCallback(() => {
    if (!identity) return;
    const blob = exportIdentity(identity);
    const file = new Blob([blob], { type: "text/plain" });
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = "aegis-identity.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [identity]);

  return (
    <div className="flex flex-1 items-center justify-center p-6 sm:p-12">
      <Card className="w-full max-w-xl shadow-[var(--shadow-brutal-xl)]">
        <CardHeader>
          <CardTitle className="font-heading text-2xl font-black uppercase tracking-tight">
            Identity required
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {identity ? (
            <>
              <div>
                <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
                  your public key
                </p>
                <p className="mt-1 font-mono text-lg font-bold break-all">
                  {truncatePubkey(pubkeyHex(identity))}
                </p>
                <p className="text-muted-foreground mt-2 break-all font-mono text-xs">
                  {pubkeyHex(identity)}
                </p>
              </div>
              <div className="border-2 border-foreground bg-muted p-3 text-sm">
                <p className="font-mono text-[10px] uppercase tracking-widest">
                  warning
                </p>
                <p className="mt-1 leading-relaxed">
                  Your secret key lives in this browser only. If you clear
                  storage or switch devices without exporting, this identity
                  is lost forever.
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void copy();
                  }}
                  className="shadow-[var(--shadow-brutal)]"
                >
                  {copied ? "Copied!" : "Copy pubkey"}
                </Button>
                <Button
                  type="button"
                  onClick={exportKey}
                  className="shadow-[var(--shadow-brutal)]"
                >
                  Export identity
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm leading-relaxed">
                Herald needs an Aegis identity to send and receive messages.
                Generating one creates a fresh secp256k1 keypair and stores
                it in your browser.
              </p>
              <p className="text-muted-foreground text-sm leading-relaxed">
                Nothing is sent to a server during generation.
              </p>
              {error ? (
                <p className="font-mono text-xs">{error}</p>
              ) : null}
              <Button
                type="button"
                onClick={() => {
                  void generate();
                }}
                disabled={busy}
                className="shadow-[var(--shadow-brutal-lg)]"
              >
                {busy ? "Generating…" : "Generate identity"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
