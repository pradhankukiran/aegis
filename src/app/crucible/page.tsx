"use client";

/**
 * Crucible — source-side page (`/crucible`).
 *
 * Anonymous, no identity required. Lifecycle:
 *
 *   1. Mount → useTransport(transientIdentity) builds an AegisTransport.
 *      The "identity" we hand to the transport is a *throwaway* ephemeral
 *      keypair used only as the transport's local sender id (Nostr pubkey
 *      / Matrix MXID derivation). It is NOT the source's submission
 *      ephemeral — that one lives in `submitDrop` and is wiped after
 *      every drop.
 *   2. <TorIndicator /> renders the connection-mode badge.
 *   3. <SourceDropbox /> collects newsroom pubkey + message + optional
 *      file. On submit we call `submit(...)` from `useSubmitDrop`.
 *   4. On success we swap to <SuccessScreen /> and the source decides
 *      when to start a new drop.
 *
 * # Why a throwaway transport identity
 *
 * `AegisTransport` requires a constructor `identity`. We don't want to
 * load the user's persistent Aegis identity here (the whole point of
 * the source side is no identity). So we generate a NEW ephemeral
 * identity at mount time, hand it to the transport, and never persist
 * it. This means each browser tab that visits `/crucible` looks like a
 * different Nostr sender / SSB feed / Matrix MXID — exactly the kind
 * of metadata posture an anonymous source wants.
 *
 * That throwaway transport identity is distinct from the per-drop
 * ephemeral that the `submitDrop` pipeline generates (which is used
 * for ECDH-to-newsroom). The two NEVER share key material.
 *
 * # NO IDB persistence
 *
 * This page does not import from `lib/crucible/store`. Grep-verifiable.
 * `useTransport` does call into `lib/identity` internally — but only
 * the `generateIdentity` path; `saveIdentity` (which writes to IDB) is
 * NOT called here.
 */

import { useCallback, useEffect, useState } from "react";
import { Siren } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Watermark } from "@/components/layout/watermark";

import { SourceDropbox } from "@/components/crucible/SourceDropbox";
import { SuccessScreen } from "@/components/crucible/SuccessScreen";
import { TorIndicator } from "@/components/crucible/TorIndicator";

import { useSubmitDrop, useTransport } from "@/lib/crucible";
import { generateIdentity } from "@/lib/identity";
import type { Identity } from "@/lib/identity";
import type { SubmitResult } from "@/lib/crucible";

export default function CrucibleSourcePage() {
  // Throwaway transport identity. See file header. Generated once per
  // page mount; never saved to IDB.
  const [transportIdentity, setTransportIdentity] = useState<Identity | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    generateIdentity().then((id) => {
      if (cancelled) return;
      setTransportIdentity(id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const { transport, ready: transportReady } = useTransport(transportIdentity);
  const { submit, isWorking, error, reset } = useSubmitDrop(transport);
  const [result, setResult] = useState<SubmitResult | null>(null);

  const handleSubmit = useCallback(
    async (newsroomPubkey: string, message: string, file?: File) => {
      const r = await submit(newsroomPubkey, message, file);
      if (r) setResult(r);
    },
    [submit],
  );

  const handleSubmitAnother = useCallback(() => {
    setResult(null);
    reset();
  }, [reset]);

  return (
    <main className="relative z-10 flex flex-1 flex-col">
      <Watermark />
      <PageHeader
        icon={Siren}
        eyebrow="Phase 5"
        title="Crucible"
        description="Anonymous source drop. Your submission is encrypted to the newsroom&apos;s key in your browser, uploaded to IPFS, and announced across three independent networks."
        spot="crucible"
      />
      <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-foreground bg-background px-4 py-3 sm:px-6">
        <TorIndicator />
        <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
          {transportReady ? "transport ready" : "transport pending"}
        </p>
      </div>

      {result ? (
        <SuccessScreen
          result={result}
          onSubmitAnother={handleSubmitAnother}
        />
      ) : (
        <SourceDropbox
          onSubmit={(pk, msg, file) => {
            void handleSubmit(pk, msg, file);
          }}
          working={isWorking}
          error={error}
          transportPending={!transportReady}
        />
      )}
    </main>
  );
}
