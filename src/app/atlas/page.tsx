"use client";

/**
 * Atlas — `/atlas` route. Encrypted live location sharing with a circle of
 * trusted contacts (plan §3.3).
 *
 * Lifecycle:
 *
 *   1. Mount → useIdentity loads from IndexedDB.
 *      - No identity:  render <IdentityRequired /> CTA. After generation
 *                      the hook re-renders with the new id.
 *      - Has identity: continue.
 *   2. useTransport(id) builds an AegisTransport and connects to every
 *      configured network. We don't surface a status badge bar here — the
 *      ShareToggle's lastError surface is enough for v1.
 *   3. useLocationBridge subscribes to subscribeDM; each well-formed
 *      `aegis.location` envelope is persisted via attachLocationBridge and
 *      triggers a refresh of the live `fixesByMember` map (which in turn
 *      re-renders the map markers).
 *   4. The user adds members, toggles share on, and the share-service
 *      starts firing `transport.directMessage` per recipient on each
 *      5-minute tick.
 *
 * # SSR strategy for Leaflet
 *
 * Leaflet touches `window` at import time, which crashes Next.js SSR. We
 * load <AtlasMap/> via `next/dynamic({ssr: false})` so its bundle never
 * lands in the SSR pass AND only ships to the client after first paint.
 * <AtlasMap/> internally lazy-imports `react-leaflet` from a useEffect
 * for the same reason.
 */

import { useCallback } from "react";
import dynamic from "next/dynamic";
import { MapPin } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Watermark } from "@/components/layout/watermark";

import { pubkeyHex } from "@/lib/identity";
import {
  describeGeolocationError,
  truncatePubkey,
  useCircle,
  useIdentity,
  useLocationBridge,
  usePermissionState,
  useReceivedFixes,
  useShare,
  useTransport,
} from "@/lib/atlas";

import { AddMemberDialog } from "@/components/atlas/AddMemberDialog";
import { CirclePanel } from "@/components/atlas/CirclePanel";
import { IdentityRequired } from "@/components/atlas/IdentityRequired";
import { PermissionState } from "@/components/atlas/PermissionState";
import { ShareToggle } from "@/components/atlas/ShareToggle";

/**
 * Dynamically import the map so the leaflet/react-leaflet bundle stays out
 * of the SSR pass and out of the initial client payload. `ssr: false` is
 * Next 16's mechanism for opting a Client Component out of prerender; it's
 * only valid inside Client Components (which this page is — note the
 * `"use client"` directive at the top).
 */
const AtlasMap = dynamic(
  () => import("@/components/atlas/Map").then((m) => m.AtlasMap),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center border-2 border-foreground bg-muted">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          loading map…
        </p>
      </div>
    ),
  },
);

export default function AtlasPage() {
  const { identity, ready: identityReady, generate } = useIdentity();

  // Identity gate — same pattern as Herald.
  if (!identityReady) {
    return (
      <main className="relative z-10 flex flex-1 flex-col">
        <Watermark />
        <PageHeader
          icon={MapPin}
          eyebrow="Phase 4"
          title="Atlas"
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
          icon={MapPin}
          eyebrow="Phase 4"
          title="Atlas"
          description="Encrypted live location sharing with a trusted circle."
        />
        <IdentityRequired onGenerate={generate} />
      </main>
    );
  }

  return <AtlasShell identity={identity} />;
}

function AtlasShell({
  identity,
}: {
  identity: NonNullable<ReturnType<typeof useIdentity>["identity"]>;
}) {
  const { transport, ready: transportReady } = useTransport(identity);
  const { members, addMember, removeMember } = useCircle();
  const { fixesByMember, refresh: refreshFixes } = useReceivedFixes();
  const { permission } = usePermissionState();

  // Inbound bridge: every persisted location DM bumps the fix map.
  // We re-read from IDB rather than splicing the in-flight fix into state
  // directly — keeps the source of truth single and ensures cap-evicted
  // samples never re-appear in memory.
  const onIncomingFix = useCallback(() => {
    void refreshFixes();
  }, [refreshFixes]);
  useLocationBridge(transport, onIncomingFix);

  // Share controller — start/stop with the live member list.
  const { session, lastTickAt, lastError, start, stop } = useShare(
    transport,
    members,
  );

  const handleAdd = useCallback(
    async (pubkey: string, nickname?: string) => {
      await addMember(pubkey, nickname);
    },
    [addMember],
  );

  const lastErrorMessage = lastError
    ? describeGeolocationError(lastError)
    : null;

  return (
    <main className="relative z-10 flex flex-1 flex-col">
      <Watermark />
      <PageHeader
        icon={MapPin}
        eyebrow="Phase 4"
        title="Atlas"
        description={`You are ${truncatePubkey(pubkeyHex(identity))} · live location encrypted per-recipient over the three-network mesh.`}
      />
      <div className="flex items-center justify-between gap-3 border-b-2 border-foreground bg-background px-4 py-2 sm:px-6">
        <PermissionState state={permission} />
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {transportReady ? "transport ready" : "transport pending"}
        </p>
      </div>
      <ShareToggle
        session={session}
        memberCount={members.length}
        lastTickAt={lastTickAt}
        lastErrorMessage={lastErrorMessage}
        disabled={!transportReady || members.length === 0}
        onStart={start}
        onStop={stop}
      />
      <div className="grid flex-1 grid-cols-1 overflow-hidden md:grid-cols-[1fr_320px]">
        <div className="relative h-[60vh] min-h-[400px] md:h-auto">
          <AtlasMap members={members} fixesByMember={fixesByMember} />
        </div>
        <CirclePanel
          members={members}
          fixesByMember={fixesByMember}
          onRemove={removeMember}
          onAdd={<AddMemberDialog onAdd={handleAdd} />}
        />
      </div>
    </main>
  );
}
