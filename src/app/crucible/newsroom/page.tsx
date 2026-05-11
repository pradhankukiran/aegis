"use client";

/**
 * Crucible — newsroom-side page (`/crucible/newsroom`).
 *
 * Signed in. Lifecycle:
 *
 *   1. Mount → useIdentity loads from IndexedDB.
 *      - No identity: render Herald's <IdentityPanel /> CTA (the same
 *        component every other Aegis feature reuses for the identity
 *        gate).
 *      - Has identity: continue.
 *   2. useTransport(id) builds an AegisTransport and connects to every
 *      configured network. Status is reflected in the header strip.
 *   3. useDropReceiver(transport, identity) starts the subscribe + fetch
 *      + decrypt + persist loop. Each new drop refreshes the dashboard
 *      list.
 *   4. <NewsroomDashboard /> renders the list + detail. Filter controls
 *      live in the sidebar.
 *   5. When the list is empty, <NewsroomEmptyState /> shows the
 *      newsroom pubkey with a one-click copy so the newsroom can share
 *      it with potential sources.
 *
 * matrix-js-sdk is heavy (WASM, IndexedDB, sync loop) — the dynamic
 * import inside `useTransport` keeps it off the SSR pass and out of the
 * initial client bundle. We reuse that pattern here.
 */
import { useCallback } from "react";
import { Siren } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Watermark } from "@/components/layout/watermark";

import { IdentityPanel } from "@/components/herald/IdentityPanel";

import { NewsroomDashboard } from "@/components/crucible/NewsroomDashboard";
import { NewsroomEmptyState } from "@/components/crucible/NewsroomEmptyState";

import {
  truncatePubkey,
  useDropReceiver,
  useDrops,
  useIdentity,
  useTransport,
} from "@/lib/crucible";
import { pubkeyHex } from "@/lib/identity";
import type { Identity } from "@/lib/identity";

export default function CrucibleNewsroomPage() {
  const { identity, ready: identityReady, generate } = useIdentity();

  if (!identityReady) {
    return (
      <main className="relative z-10 flex flex-1 flex-col">
        <Watermark />
        <PageHeader
          icon={Siren}
          eyebrow="Phase 5"
          title="Crucible · Newsroom"
          description="Loading identity…"
          spot="crucible"
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
          icon={Siren}
          eyebrow="Phase 5"
          title="Crucible · Newsroom"
          description="Receive encrypted whistleblower drops sealed to your Aegis identity, replicated across three networks."
          spot="crucible"
        />
        <IdentityPanel identity={null} onGenerate={generate} />
      </main>
    );
  }

  return <NewsroomShell identity={identity} />;
}

function NewsroomShell({ identity }: { identity: Identity }) {
  const { transport, ready: transportReady } = useTransport(identity);
  const { drops, refresh, markRead } = useDrops();

  // Every newly decrypted drop triggers a refresh so the dashboard list
  // updates immediately. The bridge has already persisted the drop to
  // IDB by the time onDrop fires.
  const onDrop = useCallback(() => {
    void refresh();
  }, [refresh]);
  useDropReceiver(transport, identity, onDrop);

  return (
    <main className="relative z-10 flex flex-1 flex-col">
      <Watermark />
      <PageHeader
        icon={Siren}
        eyebrow="Phase 5"
        title="Crucible · Newsroom"
        description={`You are ${truncatePubkey(pubkeyHex(identity))} · decrypting drops sealed to your public key, fanned in across Matrix and Nostr.`}
        spot="crucible"
      />
      <div className="flex items-center justify-between gap-3 border-b-2 border-foreground bg-background px-4 py-3 sm:px-6">
        <p className="font-mono text-[10px] font-bold uppercase tracking-widest">
          drops · {drops.length}
        </p>
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {transportReady ? "transport ready" : "transport pending"}
        </p>
      </div>

      {drops.length === 0 ? (
        <NewsroomEmptyState identity={identity} />
      ) : (
        <NewsroomDashboard drops={drops} onMarkRead={markRead} />
      )}
    </main>
  );
}
