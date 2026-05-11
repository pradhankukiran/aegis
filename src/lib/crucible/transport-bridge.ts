/**
 * Crucible — wires `AegisTransport.subscribe({type: "aegis.crucible.drop"})`
 * to the newsroom-side decrypt + persist pipeline.
 *
 * # Flow (newsroom side)
 *
 *   1. Subscribe to `type="aegis.crucible.drop"` events on every connected
 *      Aegis network.
 *   2. For each event:
 *        a. Validate the content shape (a `CruciblePointer`).
 *        b. Filter on `content.to` matching the newsroom's pubkey hex in
 *           either canonical form (compressed 66-hex OR x-only 64-hex).
 *        c. Fetch ciphertext from Pinata via `cid`.
 *        d. Re-derive ECDH(newsroom.seckey, ephemeralPubkey) → CEK.
 *        e. Decrypt the envelope.
 *        f. Persist the `DecryptedDrop` to IDB.
 *        g. Fire the optional UI callback.
 *
 * Errors at any step are logged to console and the event is silently
 * dropped — a malformed event or a Pinata 404 must NOT tear down the
 * subscription that delivers all the well-formed drops.
 *
 * # `to` filter — accept both canonical forms
 *
 * The newsroom publishes its pubkey somewhere (a website footer, a printed
 * card, a QR code). Sources will type whatever form the newsroom shared,
 * which means we must match both 66-char compressed and 64-char x-only
 * pubkeys against our local identity. `matchesNewsroom` does this by
 * pre-computing both forms once and string-comparing.
 *
 * # `from` field
 *
 * Crucible pointer events are anonymous by design — the source's `sender`
 * (Nostr pubkey, Matrix MXID) is whatever throwaway transport
 * identity the source happens to have. We do not log or persist the
 * sender's id; the newsroom only sees the source's `ephemeralPubkey`.
 */
import { fetchCiphertext } from "../pinata";
import type { AegisTransport, AegisEvent } from "../transport";

import { deriveSharedKey, peerPubkeyBytesFromHex } from "./ecdh";
import { decryptDrop } from "./envelope";
import { saveDrop } from "./store";
import { dropIdFromPointer } from "./submit";
import {
  CRUCIBLE_EVENT_TYPE,
  type CruciblePointer,
  type DecryptedDrop,
} from "./types";

/**
 * Attach the newsroom subscriber. Returns the unsubscribe handle from
 * `transport.subscribe` — callers should hold onto it for cleanup on
 * transport close / identity change.
 *
 * `newsroomPubkeyHexes` is the set of acceptable `to` values. Pass at
 * least one (the canonical form your UI advertises); we recommend
 * passing BOTH 66- and 64-char forms so a source who copied either way
 * lands. `useDropReceiver` builds this set automatically.
 *
 * `newsroomSeckey` is the local identity's secret scalar — 32 bytes.
 * Used only for ECDH; never persisted by this module.
 */
export function attachNewsroomBridge(
  transport: AegisTransport,
  newsroomSeckey: Uint8Array,
  newsroomPubkeyHexes: string[],
  onDrop?: (drop: DecryptedDrop) => void,
): () => void {
  // Pre-canonicalize the acceptable `to` forms once.
  const acceptable = new Set<string>(
    newsroomPubkeyHexes.map((h) => h.trim().toLowerCase()),
  );
  return transport.subscribe(
    { type: CRUCIBLE_EVENT_TYPE },
    (ev) => {
      handleEvent(ev, acceptable, newsroomSeckey, onDrop).catch((err) => {
        console.error("[crucible] newsroom bridge error:", err);
      });
    },
  );
}

async function handleEvent(
  ev: AegisEvent,
  acceptable: Set<string>,
  newsroomSeckey: Uint8Array,
  onDrop?: (drop: DecryptedDrop) => void,
): Promise<void> {
  const pointer = parseCruciblePointer(ev);
  if (!pointer) return;
  if (!acceptable.has(pointer.to.trim().toLowerCase())) {
    // Not addressed to us — ignore silently. A passive subscriber on a
    // public network would otherwise log a stream of "not for me" lines.
    return;
  }
  let ciphertext: Uint8Array;
  try {
    ciphertext = await fetchCiphertext(pointer.cid);
  } catch (err) {
    console.warn(`[crucible] fetch ${pointer.cid} failed:`, err);
    return;
  }
  let ephemeralPubkeyBytes: Uint8Array;
  try {
    ephemeralPubkeyBytes = peerPubkeyBytesFromHex(pointer.ephemeralPubkey);
  } catch (err) {
    console.warn("[crucible] malformed ephemeralPubkey:", err);
    return;
  }
  let cek: Uint8Array | null = null;
  try {
    cek = deriveSharedKey(newsroomSeckey, ephemeralPubkeyBytes);
    const { plaintext, attachments } = await decryptDrop(ciphertext, cek);
    const id = dropIdFromPointer(pointer.cid, pointer.ephemeralPubkey);
    const drop: DecryptedDrop = {
      id,
      to: pointer.to,
      ephemeralPubkey: pointer.ephemeralPubkey,
      cid: pointer.cid,
      ts: pointer.ts,
      plaintext,
      ...(attachments ? { attachments } : {}),
      read: false,
    };
    await saveDrop(drop);
    onDrop?.(drop);
  } catch (err) {
    console.warn(`[crucible] decrypt/persist ${pointer.cid} failed:`, err);
  } finally {
    if (cek) cek.fill(0);
  }
}

/**
 * Validate that an AegisEvent's `content` is a well-formed CruciblePointer.
 * Returns the typed pointer on success or `null` on any mismatch.
 *
 * Exported for unit tests; the bridge itself only consumes the result.
 */
export function parseCruciblePointer(
  ev: AegisEvent,
): CruciblePointer | null {
  if (!ev || ev.type !== CRUCIBLE_EVENT_TYPE) return null;
  const c = ev.content;
  if (!c || typeof c !== "object") return null;
  const obj = c as Record<string, unknown>;
  if (typeof obj.to !== "string" || obj.to.length === 0) return null;
  if (
    typeof obj.ephemeralPubkey !== "string" ||
    !/^[0-9a-fA-F]+$/.test(obj.ephemeralPubkey)
  ) {
    return null;
  }
  if (
    obj.ephemeralPubkey.length !== 64 &&
    obj.ephemeralPubkey.length !== 66
  ) {
    return null;
  }
  if (typeof obj.cid !== "string" || obj.cid.length === 0) return null;
  if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) return null;
  return {
    to: obj.to,
    ephemeralPubkey: obj.ephemeralPubkey.toLowerCase(),
    cid: obj.cid,
    ts: obj.ts,
  };
}
