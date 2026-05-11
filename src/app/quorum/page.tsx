"use client";

/**
 * Quorum — `/quorum` route. Index page: live list of polls (mine + ones
 * discovered through the cross-network bridge) plus a "create poll" CTA.
 *
 * Lifecycle:
 *
 *   1. Mount → useIdentity loads from IndexedDB.
 *      - No identity: render <IdentityRequired/>-style CTA inline. After
 *                     generation the hook re-renders with the new id.
 *      - Has identity: continue.
 *   2. useTransport(id) builds an AegisTransport and connects to every
 *      configured network. Status badges are deferred — Quorum's
 *      surface is poll-centric and per-network status isn't load-bearing.
 *   3. useQuorumBridge(transport) wires the inbound poll/ballot bridge so
 *      polls a peer creates surface automatically. Each delivery triggers
 *      a `refresh()` on the poll list.
 *   4. The user clicks "Create poll" → router.push('/quorum/new').
 *
 * The Aegis identity-required pattern mirrors Atlas / Herald exactly.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Vote } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Watermark } from "@/components/layout/watermark";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { signerHexFromIdentity } from "@/lib/witness";
import type { Identity } from "@/lib/identity";
import {
  truncatePubkey,
  useIdentity,
  usePolls,
  useQuorumBridge,
  useTransport,
} from "@/lib/quorum";

import { PollList } from "@/components/quorum/PollList";

export default function QuorumPage() {
  const { identity, ready: identityReady, generate } = useIdentity();

  if (!identityReady) {
    return (
      <main className="relative z-10 flex flex-1 flex-col">
        <Watermark />
        <PageHeader
          icon={Vote}
          eyebrow="Phase 5"
          title="Quorum"
          description="Loading identity…"
          spot="quorum"
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
          icon={Vote}
          eyebrow="Phase 5"
          title="Quorum"
          description="Sealed-ballot voting. Every vote is timelock-encrypted to the close round — nobody (including the poll creator) sees a single ballot until after close."
          spot="quorum"
        />
        <IdentityRequired onGenerate={generate} />
      </main>
    );
  }

  return <QuorumShell identity={identity} />;
}

function QuorumShell({ identity }: { identity: Identity }) {
  const { transport, ready: transportReady } = useTransport(identity);
  const { polls, refresh } = usePolls();
  const [now, setNow] = useState<number>(() => Date.now());

  // Tick once a second for the countdowns in the list.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const onPoll = useCallback(() => {
    void refresh();
  }, [refresh]);
  useQuorumBridge(transport, { onPoll });

  const myPubkey = signerHexFromIdentity(identity);

  return (
    <main className="relative z-10 flex flex-1 flex-col">
      <Watermark />
      <PageHeader
        icon={Vote}
        eyebrow="Phase 5"
        title="Quorum"
        description={`You are ${truncatePubkey(myPubkey)} · ballots are timelock-encrypted to a drand quicknet round and tallied after close.`}
        spot="quorum"
      />
      <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-foreground bg-background px-4 py-3 sm:px-6">
        <p className="font-mono text-[10px] uppercase tracking-widest">
          {transportReady ? "transport ready" : "transport pending"}
          <span className="text-muted-foreground">
            {" · "}
            {polls.length} poll{polls.length === 1 ? "" : "s"}
          </span>
        </p>
        <Button asChild size="sm" className="font-bold uppercase tracking-wide">
          <Link href="/quorum/new">+ Create poll</Link>
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <PollList polls={polls} myPubkey={myPubkey} now={now} />
      </div>
    </main>
  );
}

/**
 * Identity-required CTA. Mirrors Atlas / Herald's pattern but
 * Quorum-flavored. Inlined here per the strict file-constraint that
 * forbids touching the other features' components.
 */
function IdentityRequired({
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
            Quorum needs an Aegis identity so other voters can verify the
            signature embedded inside each sealed ballot. Generating one
            creates a fresh secp256k1 keypair and stores it in your
            browser.
          </p>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Nothing is sent to a server during generation. Use Herald with
            the same identity to receive poll invitations from peers.
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
