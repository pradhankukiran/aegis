"use client";

/**
 * Empty-state hero for the Witness page when no anchor has been created in
 * this session. Pairs with `FileDropzone` — the dropzone sits at the top of
 * the page; this card explains what Witness does below it.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function EmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center p-6 sm:p-12">
      <Card className="w-full max-w-xl shadow-[var(--shadow-brutal-xl)]">
        <CardHeader>
          <CardTitle className="font-heading text-2xl font-black uppercase tracking-tight">
            Drop a file to anchor it
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm leading-relaxed">
            Witness computes a SHA-256 fingerprint of your file, signs it
            with your Aegis identity, and broadcasts the proof across Nostr,
            Matrix, and SSB simultaneously.
          </p>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Anyone with the resulting proof URL can verify the timestamp
            against all three networks. An adversary would need to compromise
            every one of them to deny it.
          </p>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Nothing is uploaded — your file never leaves the browser, only
            its hash and signature.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
