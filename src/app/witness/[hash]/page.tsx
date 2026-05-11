"use client";

/**
 * Witness — `/witness/[hash]` proof viewer.
 *
 * Loads transport (lazily, just like the index page), normalizes the
 * pasted hash (accepts both 64-char hex and `0x`-prefixed forms), then
 * fans out to `useVerify` for the live cross-network check.
 *
 * Identity is NOT required to verify — a fresh visitor with no Aegis
 * identity can still see whether a hash is anchored anywhere. We do still
 * mount the transport (which requires an identity to build) when one is
 * available, so the live presence check can happen. When the visitor has
 * no identity yet, the page surfaces only the signature/local-record
 * verdict and prompts them to generate one for the live network check.
 */
import { use, useMemo } from "react";
import Link from "next/link";
import { FileCheck2 } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Watermark } from "@/components/layout/watermark";
import { Button } from "@/components/ui/button";

import { useIdentity, useTransport } from "@/lib/herald";
import { isValidHash, normalizeHash, useVerify } from "@/lib/witness";

import { NetworkStatusBadges } from "@/components/herald/NetworkStatusBadges";

import { ProofViewer } from "@/components/witness/ProofViewer";

export default function WitnessProofPage({
  params,
}: {
  // Next.js 16 dynamic-route params are a Promise — see
  // node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
  // dynamic-routes.md. We use `use()` for the client-side unwrap.
  params: Promise<{ hash: string }>;
}) {
  const resolved = use(params);
  return <WitnessProof rawHash={resolved.hash} />;
}

function WitnessProof({ rawHash }: { rawHash: string }) {
  const { identity, ready: identityReady } = useIdentity();
  const { transport, status } = useTransport(identity);

  // Normalize once. `null` means "unparseable hash"; the page renders an
  // error state and offers a way back.
  const normalized = useMemo<string | null>(() => {
    try {
      return normalizeHash(rawHash);
    } catch {
      return null;
    }
  }, [rawHash]);

  const { verification, localRecord, isLoading, error, refresh } = useVerify(
    transport,
    normalized,
  );

  // UX: if a fresh visitor lands here with no identity, offer the option
  // to generate one so the live network query can happen. (We don't
  // auto-generate — that would silently bind a key to their browser
  // without consent.) Derived from identityReady/identity so we avoid an
  // effect-driven flag.
  const showIdentityPrompt = identityReady && !identity;

  if (normalized === null) {
    return (
      <main className="relative z-10 flex flex-1 flex-col">
        <Watermark />
        <PageHeader
          icon={FileCheck2}
          eyebrow="Phase 4"
          title="Witness — invalid proof URL"
          description={
            isValidHash(rawHash)
              ? "Could not normalize the hash."
              : "The hash in the URL is not a 64-char hex SHA-256."
          }
        />
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
          <p className="text-muted-foreground font-mono text-sm break-all">
            {rawHash}
          </p>
          <div>
            <Link href="/witness">
              <Button
                type="button"
                variant="neutral"
                className="shadow-[var(--shadow-brutal)]"
              >
                Back to Witness
              </Button>
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="relative z-10 flex flex-1 flex-col">
      <Watermark />
      <PageHeader
        icon={FileCheck2}
        eyebrow="Phase 4"
        title="Witness — verify"
        description="Checking the signature and per-network presence for this anchor."
      />
      <div className="flex items-center justify-between gap-3 border-b-2 border-foreground bg-background px-4 py-3 sm:px-6">
        <NetworkStatusBadges status={status} />
        <Link href="/witness">
          <Button
            type="button"
            variant="neutral"
            size="sm"
            className="shadow-[var(--shadow-brutal)]"
          >
            New anchor
          </Button>
        </Link>
      </div>

      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
        {showIdentityPrompt ? (
          <div className="border-2 border-dashed border-foreground bg-background px-4 py-3">
            <p className="font-mono text-[10px] uppercase tracking-widest">
              live network check unavailable
            </p>
            <p className="mt-1 text-sm leading-relaxed">
              Witness needs an Aegis identity to open transport sockets and
              query the three networks for this hash. The signature can
              still be verified offline; for the live check, go to{" "}
              <Link href="/witness" className="underline">
                /witness
              </Link>{" "}
              and generate one.
            </p>
          </div>
        ) : null}

        <ProofViewer
          hash={normalized}
          verification={verification}
          localRecord={localRecord}
          isLoading={isLoading}
          error={error}
          onRefresh={() => {
            void refresh();
          }}
        />
      </div>
    </main>
  );
}
