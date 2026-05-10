/**
 * Crucible — newsroom-side receive helpers.
 *
 * Thin wrapper around `attachNewsroomBridge` that exposes a friendlier
 * `subscribe({onDrop})` API for the dashboard hook. Keeps the page-side
 * code free of bridge plumbing.
 *
 * The heavy lifting (subscribe → fetch → decrypt → persist) lives in
 * `transport-bridge.ts`. This module is intentionally small.
 */
import type { Identity } from "../identity";
import { pubkeyHex } from "../identity";
import type { AegisTransport } from "../transport";

import { attachNewsroomBridge } from "./transport-bridge";
import type { DecryptedDrop } from "./types";

/**
 * Build a `subscribe(onDrop)` closure scoped to the newsroom identity.
 *
 * Usage:
 *   ```ts
 *   const recv = createDropReceiver(transport, identity);
 *   const stop = recv.subscribe((drop) => { ...refresh dashboard... });
 *   // later:
 *   stop();
 *   ```
 *
 * The receiver accepts drops addressed to either canonical form of the
 * newsroom pubkey (66-char SEC1-compressed OR 64-char x-only). The
 * matching is done in `attachNewsroomBridge` against an internal set;
 * we feed both forms in so a source that copied either works.
 */
export function createDropReceiver(
  transport: AegisTransport,
  identity: Identity,
): {
  subscribe: (onDrop: (drop: DecryptedDrop) => void) => () => void;
} {
  // Compute BOTH acceptable forms of the newsroom pubkey:
  //   - 66 hex chars: SEC1-compressed identity.pubkey
  //   - 64 hex chars: x-only (strip the parity prefix byte)
  // We accept either at the `to`-filter level so the source can use
  // whichever form they were handed.
  const compressed = pubkeyHex(identity);
  const xOnly = compressed.length === 66 ? compressed.slice(2) : compressed;
  const acceptable = [compressed, xOnly];

  return {
    subscribe(onDrop) {
      return attachNewsroomBridge(
        transport,
        identity.seckey,
        acceptable,
        onDrop,
      );
    },
  };
}
