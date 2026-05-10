"use client";

/**
 * Beacon — `/beacon` route. The Phase 5 dead-man's broadcast feature.
 *
 * Lifecycle:
 *
 *   1. Mount → useIdentity (re-used from Herald) loads from IndexedDB.
 *      - No identity:  render <IdentityPanel /> with the shared
 *                      "Generate" CTA. Identity is per-user, not per-feature.
 *      - Has identity: continue.
 *   2. useTransport(id) builds an AegisTransport. Publishing the
 *      timelock-encrypted release events at create time is fan-out via
 *      the transport facade.
 *   3. useWatchdog(t) mounts a 60s interval that scans persisted beacons
 *      and fires any whose deadline has passed. The watchdog also attaches
 *      the inbound bridge so a fire/cancel arriving on another device is
 *      reflected locally.
 *   4. The user creates beacons, checks in periodically, or cancels.
 *
 * The whole feature is gated on identity; the transport is best-effort
 * (we'll save beacons locally even if no network connected, but the
 * timelock-publish step will be a no-op and the row will surface
 * "slow-path not anchored").
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Radio } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Watermark } from "@/components/layout/watermark";

import {
  truncatePubkey,
  useIdentity,
  useTransport,
} from "@/lib/herald";
import { pubkeyHex } from "@/lib/identity";
import type { Identity } from "@/lib/identity";

import {
  useBeacons,
  useCancelBeacon,
  useCheckin,
  useCreateBeacon,
  useDeleteBeacon,
  useFireBeacon,
  useWatchdog,
} from "@/lib/beacon";
import type { Beacon } from "@/lib/beacon";

import { IdentityPanel } from "@/components/herald/IdentityPanel";
import { NetworkStatusBadges } from "@/components/herald/NetworkStatusBadges";

import { BeaconDetail } from "@/components/beacon/BeaconDetail";
import { BeaconList } from "@/components/beacon/BeaconList";
import { CreateBeaconForm } from "@/components/beacon/CreateBeaconForm";

export default function BeaconPage() {
  const { identity, ready: identityReady, generate } = useIdentity();

  if (!identityReady) {
    return (
      <main className="relative z-10 flex flex-1 flex-col">
        <Watermark />
        <PageHeader
          icon={Radio}
          eyebrow="Phase 5"
          title="Beacon"
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
          icon={Radio}
          eyebrow="Phase 5"
          title="Beacon"
          description="Emergency dead-man's broadcast — pre-encoded message that fires across all three networks when you fail to check in past a deadline."
        />
        <IdentityPanel identity={null} onGenerate={generate} />
      </main>
    );
  }

  return <BeaconWorkspace identity={identity} />;
}

function BeaconWorkspace({ identity }: { identity: Identity }) {
  const { transport, status } = useTransport(identity);
  const { beacons, refresh: refreshBeacons } = useBeacons();

  // Selection: user-chosen id, falling back to the soonest-deadline beacon
  // so the detail pane isn't empty on first paint.
  const [userSelected, setUserSelected] = useState<string | null>(null);
  const selectedId: string | null = userSelected ?? beacons[0]?.id ?? null;
  const selectedBeacon = useMemo<Beacon | null>(() => {
    if (!selectedId) return null;
    return beacons.find((b) => b.id === selectedId) ?? null;
  }, [beacons, selectedId]);

  // Watchdog + inbound bridge.
  const refreshAfterUpdate = useCallback(() => {
    void refreshBeacons();
  }, [refreshBeacons]);
  useWatchdog(transport, undefined, refreshAfterUpdate);

  // Beacon lifecycle hooks. We pass `selectedBeacon` to the action hooks
  // so they re-bind when the user clicks a different beacon row.
  const { create, isWorking: creating } = useCreateBeacon(transport);
  const { checkin, isWorking: checkingIn } = useCheckin(selectedBeacon);
  const {
    cancel,
    isWorking: cancelling,
    error: cancelError,
  } = useCancelBeacon(transport, identity, selectedBeacon);
  const {
    fireNow,
    isWorking: firing,
    error: fireError,
  } = useFireBeacon(transport, selectedBeacon);
  const { remove, isWorking: deleting } = useDeleteBeacon();

  // Periodically refresh the list so a watchdog fire (which writes IDB
  // directly) surfaces in the visible state. The watchdog's `onUpdate`
  // covers the bridge path; this catches the in-process fire path.
  useEffect(() => {
    if (typeof indexedDB === "undefined") return;
    const id = setInterval(() => {
      void refreshBeacons();
    }, 5_000);
    return () => clearInterval(id);
  }, [refreshBeacons]);

  const handleCreate = useCallback(
    async (input: Parameters<typeof create>[0]) => {
      const created = await create(input);
      await refreshBeacons();
      setUserSelected(created.id);
    },
    [create, refreshBeacons],
  );

  const handleCheckin = useCallback(async () => {
    await checkin();
    await refreshBeacons();
  }, [checkin, refreshBeacons]);

  const handleCancel = useCallback(async () => {
    await cancel();
    await refreshBeacons();
  }, [cancel, refreshBeacons]);

  const handleFireNow = useCallback(async () => {
    await fireNow();
    await refreshBeacons();
  }, [fireNow, refreshBeacons]);

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    await remove(selectedId);
    setUserSelected(null);
    await refreshBeacons();
  }, [selectedId, remove, refreshBeacons]);

  return (
    <main className="relative z-10 flex flex-1 flex-col">
      <Watermark />
      <PageHeader
        icon={Radio}
        eyebrow="Phase 5"
        title="Beacon"
        description={`You are ${truncatePubkey(pubkeyHex(identity))} · dead-man's broadcast across Matrix, Nostr, and SSB.`}
      />
      <div className="flex items-center justify-between gap-3 border-b-2 border-foreground bg-background px-4 py-3 sm:px-6">
        <NetworkStatusBadges status={status} />
        <CreateBeaconForm onCreate={handleCreate} isWorking={creating} />
      </div>
      <div className="grid flex-1 grid-cols-1 overflow-hidden md:grid-cols-[280px_1fr]">
        <BeaconList
          beacons={beacons}
          selectedId={selectedId}
          onSelect={setUserSelected}
          onCreate={() => {
            // No-op for the rail's "+ New beacon" button — the create
            // dialog already lives in the header band above. We keep the
            // rail button as a discoverable affordance but route it to
            // the same dialog by toggling a programmatic open. v1 simply
            // surfaces both entry points and lets the rail one be a
            // visual cue; click-to-trigger from rail is deferred.
          }}
          creating={creating}
        />
        {selectedBeacon ? (
          <BeaconDetail
            beacon={selectedBeacon}
            onCheckin={handleCheckin}
            checkingIn={checkingIn}
            onCancel={handleCancel}
            cancelling={cancelling}
            onFireNow={handleFireNow}
            firing={firing}
            onDelete={handleDelete}
            deleting={deleting}
            errors={{ cancel: cancelError, fire: fireError }}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6">
            <p className="text-muted-foreground font-mono text-sm uppercase tracking-wider">
              no beacon selected
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
