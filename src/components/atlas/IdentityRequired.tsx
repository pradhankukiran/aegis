"use client";

/**
 * Identity-required CTA shown on /atlas before the user has minted a
 * keypair. Same shape as Herald's IdentityPanel but Atlas-flavoured
 * messaging — kept inline (rather than importing Herald) per the
 * strict-file-constraint that forbids touching herald components.
 */

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import type { Identity } from "@/lib/identity";

export function IdentityRequired({
  onGenerate,
}: {
  onGenerate: () => Promise<Identity>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="flex flex-1 items-center justify-center p-6 sm:p-12">
      <Card className="w-full max-w-xl shadow-[var(--shadow-brutal-xl)]">
        <CardHeader>
          <CardTitle className="font-heading text-2xl font-black uppercase tracking-tight">
            Identity required
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed">
            Atlas needs an Aegis identity so peers can verify your encrypted
            position updates. Generating one creates a fresh secp256k1
            keypair and stores it in your browser.
          </p>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Nothing is sent to a server during generation. Pair this device
            with Herald to share the same identity across features.
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
        </CardContent>
      </Card>
    </div>
  );
}
