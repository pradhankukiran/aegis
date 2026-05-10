"use client";

/**
 * Witness — React hooks layered on top of the storage and anchor primitives.
 *
 * Hooks composed here:
 *
 *   useAnchorFile()      → mints an AnchorRecord from a File and persists
 *                          it. Returns `{ anchor, isWorking, error,
 *                          anchorFile }`.
 *   useAnchorHistory()   → live list of AnchorRecords from IndexedDB.
 *   useVerify(hash)      → cross-network verification for a paste-able hash.
 *
 * All three hooks are SSR-safe — IDB access is gated on `typeof indexedDB
 * !== "undefined"` and deferred to effects. The page is `"use client"` so
 * we never run on the server, but the gate gives us a clean upgrade path
 * if we ever try.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { Identity } from "../identity";
import type { AegisTransport } from "../transport";

import { publishAnchor, signAnchor } from "./anchor";
import { hashFile } from "./hash";
import { getAnchor, loadAnchors, saveAnchor } from "./storage";
import type { AnchorRecord, Verification } from "./types";
import { verifyAnchor, verifySignature } from "./verify";

/* -------------------------------------------------------------------------- */
/* useAnchorFile                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One-shot pipeline: hash → sign → publish → persist.
 *
 * Returns the most recent successful anchor as `anchor`. `isWorking` is
 * true while the pipeline runs. `error` carries a user-friendly string if
 * something blew up. Calling `anchorFile(file)` again replaces both.
 *
 * The function refuses to run without a connected transport because that's
 * the whole point of Witness — anchoring offline would give the user no
 * verifiable record on any network.
 */
export function useAnchorFile(
  transport: AegisTransport | null,
  identity: Identity | null,
): {
  anchor: AnchorRecord | null;
  isWorking: boolean;
  error: string | null;
  anchorFile: (file: File) => Promise<AnchorRecord | null>;
  reset: () => void;
} {
  const [anchor, setAnchor] = useState<AnchorRecord | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track which call is the most recent so a slow run can't stomp a faster
  // follow-up. We bump on every entry and only commit results if the call
  // we started is still the latest.
  const seqRef = useRef(0);

  const reset = useCallback(() => {
    setAnchor(null);
    setError(null);
    setIsWorking(false);
  }, []);

  const anchorFile = useCallback(
    async (file: File): Promise<AnchorRecord | null> => {
      if (!transport) {
        setError("Transport not ready — try again in a moment.");
        return null;
      }
      if (!identity) {
        setError("No identity loaded.");
        return null;
      }
      const mySeq = ++seqRef.current;
      setIsWorking(true);
      setError(null);
      try {
        const hash = await hashFile(file);
        const ts = Math.floor(Date.now() / 1000);
        const wire = signAnchor(identity, hash, ts);
        const record = await publishAnchor(transport, wire, {
          fileName: file.name,
          fileSize: file.size,
        });
        try {
          await saveAnchor(record);
        } catch (err) {
          // Persistence failures shouldn't lose the in-memory result — the
          // wire publish already happened. Log so devtools can see it.
          console.warn("[witness] saveAnchor failed:", err);
        }
        if (seqRef.current === mySeq) {
          setAnchor(record);
        }
        return record;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to anchor file.";
        if (seqRef.current === mySeq) {
          setError(message);
        }
        return null;
      } finally {
        if (seqRef.current === mySeq) {
          setIsWorking(false);
        }
      }
    },
    [transport, identity],
  );

  return { anchor, isWorking, error, anchorFile, reset };
}

/* -------------------------------------------------------------------------- */
/* useAnchorHistory                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Live history list — every AnchorRecord we've persisted locally, sorted
 * newest first. Calling `refresh()` re-reads from IndexedDB; useful after
 * an anchor completes so the row appears immediately without waiting for
 * the parent component's effect cycle.
 */
export function useAnchorHistory(): {
  records: AnchorRecord[];
  refresh: () => Promise<void>;
} {
  const [records, setRecords] = useState<AnchorRecord[]>([]);

  const refresh = useCallback((): Promise<void> => {
    if (typeof indexedDB === "undefined") return Promise.resolve();
    return loadAnchors().then((list) => {
      list.sort((a, b) => b.createdAt - a.createdAt);
      setRecords(list);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (typeof indexedDB === "undefined") return;
    loadAnchors().then((list) => {
      if (cancelled) return;
      list.sort((a, b) => b.createdAt - a.createdAt);
      setRecords(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { records, refresh };
}

/* -------------------------------------------------------------------------- */
/* useVerify                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Cross-network verification for a given hash. Two-stage:
 *
 *   1. Local IDB lookup — if we anchored the file ourselves, the record is
 *      already on disk; we surface its `networkResults` as a synthesized
 *      verification so the page renders instantly.
 *   2. Live `transport.subscribe` — when a transport is available we ALSO
 *      run `verifyAnchor` to confirm presence on each connected network.
 *      The live result supersedes the local one when it lands.
 *
 * `isLoading` is true while either step is in flight. `verification` is
 * whichever result is most recent.
 *
 * The local-first pass means the page is usable in the common case where
 * the user is verifying their own anchor, even before transports finish
 * connecting.
 */
export function useVerify(
  transport: AegisTransport | null,
  hash: string | null,
): {
  verification: Verification | null;
  localRecord: AnchorRecord | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [verification, setVerification] = useState<Verification | null>(null);
  const [localRecord, setLocalRecord] = useState<AnchorRecord | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const runVerify = useCallback(async (): Promise<void> => {
    if (!hash) {
      setVerification(null);
      setLocalRecord(null);
      return;
    }
    const mySeq = ++seqRef.current;
    setIsLoading(true);
    setError(null);

    // Stage 1: local IDB lookup. Synthesize a Verification from the
    // record's per-network results so the page can render immediately.
    if (typeof indexedDB !== "undefined") {
      try {
        const rec = await getAnchor(hash);
        if (rec && seqRef.current === mySeq) {
          setLocalRecord(rec);
          setVerification(synthesizeFromRecord(rec));
        }
      } catch (err) {
        console.warn("[witness] local verify lookup failed:", err);
      }
    }

    // Stage 2: live transport.subscribe. If we never got a transport (e.g.
    // user landed on a verify URL before identity loaded), keep the local-
    // only result.
    if (!transport) {
      if (seqRef.current === mySeq) setIsLoading(false);
      return;
    }
    try {
      const live = await verifyAnchor(transport, hash);
      if (seqRef.current === mySeq) {
        setVerification(live);
      }
    } catch (err) {
      if (seqRef.current === mySeq) {
        setError(err instanceof Error ? err.message : "Verification failed.");
      }
    } finally {
      if (seqRef.current === mySeq) setIsLoading(false);
    }
  }, [transport, hash]);

  useEffect(() => {
    // Defer one microtask so the runVerify body's setState calls fire
    // outside the effect's synchronous boundary — matches the same pattern
    // useConversations/useMessages use to satisfy
    // `react-hooks/set-state-in-effect`. The seq guard inside `runVerify`
    // makes the deferred call safe across rapid re-renders.
    Promise.resolve().then(() => {
      void runVerify();
    });
  }, [runVerify]);

  return {
    verification,
    localRecord,
    isLoading,
    error,
    refresh: runVerify,
  };
}

/**
 * Build a Verification from a locally-persisted AnchorRecord. The signature
 * check is run inline (it's cheap and synchronous-ish) so the synthesized
 * result is honest about validity, not just presence. Presence reflects
 * the per-network publish outcome — which is the strongest local proof we
 * have until the live subscribe lands.
 */
function synthesizeFromRecord(record: AnchorRecord): Verification {
  const sigOk = verifySignature(record);
  const networks = record.networkResults.map((r) => ({
    network: r.network,
    found: r.ok,
    signatureValid: r.ok ? sigOk : undefined,
    ts: r.ok ? record.ts : undefined,
  }));
  return {
    hash: record.hash,
    networks,
    overallOk: sigOk && networks.some((n) => n.found),
    fullyAnchored: sigOk && networks.every((n) => n.found),
  };
}
