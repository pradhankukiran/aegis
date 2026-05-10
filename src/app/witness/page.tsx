"use client";

/**
 * Witness — `/witness` route.
 *
 * Lifecycle:
 *
 *   1. Mount → useIdentity loads from IndexedDB.
 *      - No identity: render <IdentityPanel /> with "Generate" CTA (we
 *        reuse Herald's panel; the Aegis master identity is shared across
 *        every feature).
 *      - Has identity: continue.
 *   2. useTransport(id) builds an AegisTransport and connects to every
 *      configured network. Status is reflected in the header badges.
 *   3. useAnchorFile(...) provides the hash → sign → publish → persist
 *      pipeline. The dropzone hands files in; the result card renders the
 *      anchor + per-network status.
 *   4. useAnchorHistory() exposes prior anchors with proof-URL links.
 *
 * matrix-js-sdk is heavy (WASM, IndexedDB, sync loop) — the dynamic import
 * inside Herald's useTransport keeps it off the SSR pass and out of the
 * initial client bundle. We reuse Herald's hook here verbatim.
 */
import { useCallback, useEffect } from "react";
import { FileCheck2 } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Watermark } from "@/components/layout/watermark";

import { pubkeyHex } from "@/lib/identity";
import { truncatePubkey, useIdentity, useTransport } from "@/lib/herald";
import type { Identity } from "@/lib/identity";
import {
  useAnchorFile,
  useAnchorHistory,
} from "@/lib/witness";

import { IdentityPanel } from "@/components/herald/IdentityPanel";
import { NetworkStatusBadges } from "@/components/herald/NetworkStatusBadges";

import { AnchorHistoryList } from "@/components/witness/AnchorHistoryList";
import { AnchorResult } from "@/components/witness/AnchorResult";
import { EmptyState } from "@/components/witness/EmptyState";
import { FileDropzone } from "@/components/witness/FileDropzone";

export default function WitnessPage() {
  const { identity, ready: identityReady, generate } = useIdentity();

  if (!identityReady) {
    return (
      <main className="relative z-10 flex flex-1 flex-col">
        <Watermark />
        <PageHeader
          icon={FileCheck2}
          eyebrow="Phase 4"
          title="Witness"
          description="Loading identity…"
        />
        <div className="flex-1" />
      </main>
    );
  }

  if (!identity) {
    return (
      <main className="relative z-10 flex flex-1 flex-col">
        <Watermark />
        <PageHeader
          icon={FileCheck2}
          eyebrow="Phase 4"
          title="Witness"
          description="Multi-network file notary. Anchor a SHA-256 + signature on Nostr, Matrix, and SSB simultaneously."
        />
        <IdentityPanel identity={null} onGenerate={generate} />
      </main>
    );
  }

  return <WitnessAnchor identity={identity} />;
}

function WitnessAnchor({ identity }: { identity: Identity }) {
  const { transport, status, ready: transportReady } = useTransport(identity);
  const { anchor, isWorking, error, anchorFile } = useAnchorFile(
    transport,
    identity,
  );
  const { records, refresh: refreshHistory } = useAnchorHistory();

  // After a successful anchor, refresh the history list so the new row
  // appears immediately (instead of waiting for the next page mount).
  useEffect(() => {
    if (anchor) {
      void refreshHistory();
    }
  }, [anchor, refreshHistory]);

  const onFile = useCallback(
    (file: File) => {
      void anchorFile(file);
    },
    [anchorFile],
  );

  const composeDisabled = !transportReady;

  return (
    <main className="relative z-10 flex flex-1 flex-col">
      <Watermark />
      <PageHeader
        icon={FileCheck2}
        eyebrow="Phase 4"
        title="Witness"
        description={`You are ${truncatePubkey(pubkeyHex(identity))} · drop a file to anchor it across Matrix, Nostr, and SSB.`}
      />
      <div className="flex items-center justify-between gap-3 border-b-2 border-foreground bg-background px-4 py-3 sm:px-6">
        <NetworkStatusBadges status={status} />
        <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
          {composeDisabled
            ? "connecting…"
            : `${countConnected(status)}/3 networks ready`}
        </p>
      </div>

      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
        <FileDropzone
          onFile={onFile}
          working={isWorking}
          disabled={composeDisabled}
          helper={
            composeDisabled
              ? "Waiting for at least one network to connect…"
              : undefined
          }
        />

        {error ? (
          <div className="border-2 border-foreground bg-background px-4 py-3">
            <p className="font-mono text-[10px] uppercase tracking-widest">
              error
            </p>
            <p className="mt-1 text-sm leading-relaxed">{error}</p>
          </div>
        ) : null}

        {anchor ? <AnchorResult record={anchor} /> : null}

        {!anchor && !isWorking && records.length === 0 ? (
          <EmptyState />
        ) : null}

        {records.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="font-heading text-xl font-black uppercase tracking-tight">
              History
            </h2>
            <AnchorHistoryList records={records} />
          </section>
        ) : null}
      </div>
    </main>
  );
}

function countConnected(status: {
  nostr: boolean | null;
  matrix: boolean | null;
  ssb: boolean | null;
}): number {
  let n = 0;
  if (status.nostr === true) n += 1;
  if (status.matrix === true) n += 1;
  if (status.ssb === true) n += 1;
  return n;
}
