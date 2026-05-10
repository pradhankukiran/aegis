"use client";

/**
 * Quorum — `/quorum/new` route. Wraps `<CreatePollForm/>` with identity +
 * transport bootstrap. On submit, the form calls `useCreatePoll.create`,
 * which:
 *
 *   1. Projects `closeUnix` → drand round.
 *   2. Mints a UUID id, persists the PollMeta in IDB.
 *   3. Fans the PollMeta out across all connected networks via
 *      `transport.publish({type: "aegis.quorum.poll", content: poll})`.
 *
 * On success the form navigates to `/quorum/<id>` so the user can share
 * the link with voters.
 */

import { useCallback, useState } from "react";
import { Vote } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Watermark } from "@/components/layout/watermark";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import type { Identity } from "@/lib/identity";
import {
  useCreatePoll,
  useIdentity,
  useTransport,
} from "@/lib/quorum";

import { CreatePollForm } from "@/components/quorum/CreatePollForm";

export default function QuorumNewPage() {
  const { identity, ready: identityReady, generate } = useIdentity();

  if (!identityReady) {
    return (
      <main className="relative z-10 flex flex-1 flex-col">
        <Watermark />
        <PageHeader
          icon={Vote}
          eyebrow="Phase 5"
          title="New poll"
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
          title="New poll"
          description="Generate an Aegis identity to sign your poll."
        />
        <IdentityRequired onGenerate={generate} />
      </main>
    );
  }

  return <QuorumNewShell identity={identity} />;
}

function QuorumNewShell({ identity }: { identity: Identity }) {
  const { transport, ready: transportReady } = useTransport(identity);
  const { create, isWorking, error } = useCreatePoll(transport, identity);

  return (
    <main className="relative z-10 flex flex-1 flex-col">
      <Watermark />
      <PageHeader
        icon={Vote}
        eyebrow="Phase 5"
        title="New poll"
        description="Compose a sealed-ballot poll. The close time projects to a drand quicknet round; ballots are timelock-encrypted to that round."
      />
      <div className="flex items-center justify-between border-b-2 border-foreground bg-background px-4 py-3 sm:px-6">
        <p className="font-mono text-[10px] uppercase tracking-widest">
          {transportReady ? "transport ready" : "transport pending"}
        </p>
      </div>
      <CreatePollForm
        onCreate={create}
        isWorking={isWorking}
        hookError={error}
        disabled={!transportReady}
      />
    </main>
  );
}

/** Identity-required CTA — same shape as the index page's variant. */
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
            Quorum needs an Aegis identity to sign the poll metadata.
            Generating one creates a fresh secp256k1 keypair locally.
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
