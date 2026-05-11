"use client";

/**
 * Centre pane: detailed view of a single beacon.
 *
 * Sections:
 *
 *   1. Title + status badge + countdown.
 *   2. Metadata grid — deadline, grace, drand round, last check-in,
 *      created-at, payload CID, slow-path status.
 *   3. Actions — check in, cancel, fire now (test), delete.
 *      Different actions are enabled depending on status:
 *        - pending / checked-in: check-in, cancel, fire now.
 *        - fired / cancelled / expired: delete (and only delete).
 */
import { useCallback } from "react";

import { Button } from "@/components/ui/button";

import { formatTimestamp } from "@/lib/beacon";
import type { Beacon } from "@/lib/beacon";

import { CountdownTimer } from "./CountdownTimer";
import { FireConfirmDialog } from "./FireConfirmDialog";
import { StatusBadge } from "./StatusBadge";

export function BeaconDetail({
  beacon,
  onCheckin,
  checkingIn,
  onCancel,
  cancelling,
  onFireNow,
  firing,
  onDelete,
  deleting,
  errors,
}: {
  beacon: Beacon;
  onCheckin: () => Promise<void>;
  checkingIn: boolean;
  onCancel: () => Promise<void>;
  cancelling: boolean;
  onFireNow: () => Promise<void>;
  firing: boolean;
  onDelete: () => Promise<void>;
  deleting: boolean;
  errors: {
    cancel?: string | null;
    fire?: string | null;
  };
}) {
  const isLive = beacon.status === "pending" || beacon.status === "checked-in";

  const handleCheckin = useCallback(() => {
    void onCheckin();
  }, [onCheckin]);
  const handleCancel = useCallback(() => {
    void onCancel();
  }, [onCancel]);
  const handleDelete = useCallback(() => {
    void onDelete();
  }, [onDelete]);

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      {/* Header band */}
      <div className="border-b-2 border-foreground p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-2">
            <span className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
              beacon · {beacon.id.slice(0, 8)}
            </span>
            <h2 className="font-heading text-2xl font-black uppercase tracking-tight sm:text-3xl">
              {beacon.title}
            </h2>
          </div>
          <StatusBadge status={beacon.status} />
        </div>
        <div className="mt-4">
          <CountdownTimer beacon={beacon} />
        </div>
      </div>

      {/* Metadata grid */}
      <dl className="grid grid-cols-1 gap-4 border-b-2 border-foreground p-4 sm:grid-cols-2 sm:p-6">
        <MetaCell label="deadline" mono>
          {formatTimestamp(beacon.deadlineUnix)}
        </MetaCell>
        <MetaCell label="grace" mono>
          {beacon.graceSeconds}s
        </MetaCell>
        <MetaCell label="drand round" mono>
          {beacon.drandRound}
        </MetaCell>
        <MetaCell label="last check-in" mono>
          {beacon.lastCheckinUnix > 0
            ? formatTimestamp(beacon.lastCheckinUnix)
            : "never"}
        </MetaCell>
        <MetaCell label="created at" mono>
          {formatTimestamp(beacon.createdAt)}
        </MetaCell>
        <MetaCell label="check-in interval" mono>
          {beacon.checkinIntervalSeconds}s
        </MetaCell>
        <MetaCell label="payload cid" mono className="sm:col-span-2 break-all">
          {beacon.payloadCid}
        </MetaCell>
        <MetaCell label="slow path" className="sm:col-span-2">
          <span className="font-mono text-sm">
            {beacon.timelockedReleasesPublished
              ? "anchored on at least one network"
              : "not anchored — only fast path will fire"}
          </span>
        </MetaCell>
      </dl>

      {/* Actions */}
      <div className="p-4 sm:p-6">
        <h3 className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
          actions
        </h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {isLive ? (
            <>
              <Button
                type="button"
                onClick={handleCheckin}
                disabled={checkingIn}
                className="shadow-[var(--shadow-brutal)]"
              >
                {checkingIn ? "Checking in…" : "I'm alive (check in)"}
              </Button>
              <Button
                type="button"
                variant="neutral"
                onClick={handleCancel}
                disabled={cancelling}
                className="shadow-[var(--shadow-brutal)]"
              >
                {cancelling ? "Cancelling…" : "Cancel beacon"}
              </Button>
              <FireConfirmDialog
                beacon={beacon}
                onConfirm={onFireNow}
                isWorking={firing}
              />
            </>
          ) : (
            <Button
              type="button"
              variant="neutral"
              onClick={handleDelete}
              disabled={deleting}
              className="shadow-[var(--shadow-brutal)]"
            >
              {deleting ? "Deleting…" : "Delete row"}
            </Button>
          )}
        </div>
        {errors.cancel ? (
          <p className="mt-3 font-mono text-xs">{errors.cancel}</p>
        ) : null}
        {errors.fire ? (
          <p className="mt-3 font-mono text-xs">{errors.fire}</p>
        ) : null}
      </div>
    </div>
  );
}

function MetaCell({
  label,
  children,
  mono,
  className,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
        {label}
      </dt>
      <dd className={mono ? "mt-1 font-mono text-sm font-bold" : "mt-1 text-sm font-bold"}>
        {children}
      </dd>
    </div>
  );
}
