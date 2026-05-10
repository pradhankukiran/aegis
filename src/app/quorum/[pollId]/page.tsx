"use client";

/**
 * Quorum — `/quorum/[pollId]` route. Shows VotePane while the poll is
 * pre-close, swaps to TallyView once the drand round has been signed.
 *
 * The page is identity-required (we need to sign a ballot if the user
 * wants to vote). A future tweak might allow read-only tally viewing
 * without identity; for v1 we mirror Atlas / Herald — identity gate
 * first, then surface the active content.
 *
 * # Why poll the IDB store rather than the wire on this page
 *
 * The poll list page subscribes via the bridge; by the time the user
 * navigates to a specific poll the metadata is already in IDB (the
 * bridge persisted it). If the user lands on this URL cold (shared link,
 * no prior subscription) `usePoll` returns null and the page surfaces
 * the "poll not yet discovered" empty state. Once the bridge fires
 * `refresh()` runs and the poll lands.
 */

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Vote } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Watermark } from "@/components/layout/watermark";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import type { Identity } from "@/lib/identity";
import { signerHexFromIdentity } from "@/lib/witness";
import {
  useIdentity,
  usePoll,
  useQuorumBridge,
  useSubmitBallot,
  useTransport,
} from "@/lib/quorum";

import { EligibilityBadge } from "@/components/quorum/EligibilityBadge";
import { PollHeader } from "@/components/quorum/PollHeader";
import { TallyView } from "@/components/quorum/TallyView";
import { VotePane } from "@/components/quorum/VotePane";

export default function QuorumDetailPage({
  params,
}: {
  // Next.js 16 dynamic-route params are a Promise — see
  // node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
  // dynamic-routes.md. We use `use()` for the client-side unwrap.
  params: Promise<{ pollId: string }>;
}) {
  const resolved = use(params);
  return <QuorumDetail pollId={resolved.pollId} />;
}

function QuorumDetail({ pollId }: { pollId: string }) {
  const { identity, ready: identityReady, generate } = useIdentity();

  if (!identityReady) {
    return (
      <main className="relative z-10 flex flex-1 flex-col">
        <Watermark />
        <PageHeader
          icon={Vote}
          eyebrow="Phase 5"
          title="Poll"
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
          icon={Vote}
          eyebrow="Phase 5"
          title="Poll"
          description="Generate an Aegis identity to participate."
        />
        <IdentityRequired onGenerate={generate} />
      </main>
    );
  }

  return <QuorumDetailShell identity={identity} pollId={pollId} />;
}

function QuorumDetailShell({
  identity,
  pollId,
}: {
  identity: Identity;
  pollId: string;
}) {
  const { transport } = useTransport(identity);
  const { poll, tally, isRevealed, refresh } = usePoll(pollId);
  const {
    submit,
    isWorking,
    error,
    mySubmittedAt,
    refresh: refreshBallot,
  } = useSubmitBallot(transport, identity, poll);
  const [now, setNow] = useState<number>(() => Date.now());

  // Tick once a second so the countdown stays current.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Bridge for live updates to *this* poll. A peer fanning out a ballot
  // on Nostr lands here via the subscribe path and triggers a poll
  // refresh, so the cached ballots in the UI stay current.
  const onBallot = useCallback(() => {
    void refresh();
  }, [refresh]);
  const onPoll = useCallback(() => {
    void refresh();
  }, [refresh]);
  useQuorumBridge(transport, { onBallot, onPoll });

  const myPubkey = signerHexFromIdentity(identity);

  const handleSubmit = useCallback(
    async (optionIndex: number): Promise<void> => {
      await submit(optionIndex);
      await refresh();
      await refreshBallot();
    },
    [submit, refresh, refreshBallot],
  );

  if (!poll) {
    return (
      <main className="relative z-10 flex flex-1 flex-col">
        <Watermark />
        <PageHeader
          icon={Vote}
          eyebrow="Phase 5"
          title="Poll"
          description="Looking for this poll on the three-network mesh…"
        />
        <div className="flex flex-1 items-center justify-center p-6">
          <Card className="w-full max-w-xl shadow-[var(--shadow-brutal-xl)]">
            <CardHeader>
              <CardTitle className="font-heading text-2xl font-black uppercase tracking-tight">
                Poll not yet discovered
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-sm leading-relaxed">
                Quorum hasn&apos;t seen this poll yet on any connected
                network. Wait a moment for relays to deliver it, or go
                back to the index and create one of your own.
              </p>
              <p className="text-muted-foreground font-mono text-xs">
                id {pollId}
              </p>
              <Link
                href="/quorum"
                className="inline-flex h-8 items-center gap-1.5 self-start border-2 border-foreground bg-background px-2.5 text-sm font-bold uppercase tracking-wide shadow-[var(--shadow-brutal)]"
              >
                ← Back to polls
              </Link>
            </CardContent>
          </Card>
        </div>
      </main>
    );
  }

  const closed = now >= poll.closeUnix;
  const hasWhitelist = poll.voters.length > 0;
  const onList = !hasWhitelist || poll.voters.includes(myPubkey);
  const hasVoted = mySubmittedAt !== null;

  const eligibility = (() => {
    if (closed) return "closed" as const;
    if (hasVoted) return "already-voted" as const;
    if (!onList) return "not-listed" as const;
    return "eligible" as const;
  })();

  return (
    <main className="relative z-10 flex flex-1 flex-col">
      <Watermark />
      <PageHeader
        icon={Vote}
        eyebrow="Phase 5"
        title="Poll"
        description="Pre-close: seal a ballot. Post-close: tally is computed from the revealed drand round."
      />
      <PollHeader poll={poll} now={now} />
      <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-foreground bg-background px-4 py-2 sm:px-6">
        <EligibilityBadge state={eligibility} />
        <Link
          href="/quorum"
          className="font-mono text-[10px] uppercase tracking-widest underline-offset-4 hover:underline"
        >
          ← All polls
        </Link>
      </div>
      {isRevealed ? (
        <TallyView poll={poll} tally={tally} />
      ) : (
        <VotePane
          poll={poll}
          disabled={closed || !onList}
          hasVoted={hasVoted}
          mySubmittedAt={mySubmittedAt}
          isSubmitting={isWorking}
          error={error}
          onSubmit={handleSubmit}
        />
      )}
    </main>
  );
}

/** Identity-required CTA — mirrors the index page. */
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
            Quorum needs an Aegis identity to sign the ballot inside the
            sealed envelope. Generating one creates a fresh secp256k1
            keypair locally.
          </p>
          {error ? <p className="font-mono text-xs">{error}</p> : null}
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
