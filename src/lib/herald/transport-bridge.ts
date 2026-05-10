/**
 * Herald — wires `AegisTransport.subscribeDM` to the IndexedDB store.
 *
 * The unified `subscribeDM` channel surfaces incoming direct messages from
 * each transport (Nostr kind-14 with NIP-44 v2 decrypt, Matrix 1:1 DM
 * timeline, SSB `aegis-dm` typed event). The bridge persists each one and
 * fires an optional UI callback.
 *
 * # `from` canonicalization
 *
 * `IncomingDM.from` is whatever the origin network exposes:
 *   - nostr   → x-only 64-char hex
 *   - matrix  → MXID (e.g. `@abcd1234...:matrix.aegis.app`)
 *   - ssb     → SSB feed id (e.g. `@<base64>.ed25519`)
 *
 * Herald keys conversations by this `from` value verbatim. That means a
 * remote peer whose Matrix and Nostr identities map to different `from`
 * forms will show up as two separate conversations until Phase 4 adds an
 * MXID/SSBid → pubkey-hex directory lookup. For Phase 3 + 4-prep this is
 * accepted scope.
 */
import { appendMessage, getConversation, saveConversation } from "./store";
import type { Message } from "./types";
import type { AegisTransport, IncomingDM } from "../transport";

/**
 * Attach an incoming-DM listener to the transport. Returns the
 * `unsubscribe` function the transport handed us — callers should hold onto
 * it for cleanup (e.g. on transport close, on identity change).
 *
 * `onIncoming` lets the UI react beyond the store update (e.g. desktop
 * notification, scroll-to-bottom). It runs after the message is persisted.
 */
export function attachIncomingBridge(
  transport: AegisTransport,
  onIncoming?: (m: Message) => void,
): () => void {
  return transport.subscribeDM((dm) => {
    handleIncoming(dm, onIncoming).catch((err) => {
      // We swallow IDB errors here so a bad write doesn't tear down the
      // entire subscription. Log to console so it shows up in devtools.
      console.error("[herald] incoming bridge error:", err);
    });
  });
}

async function handleIncoming(
  dm: IncomingDM,
  onIncoming?: (m: Message) => void,
): Promise<void> {
  const msg = projectIncoming(dm);
  if (!msg) return;
  await ensureConversation(msg.convId, msg.ts);
  await appendMessage(msg);
  onIncoming?.(msg);
}

/**
 * Project an inbound IncomingDM into a Herald Message. Returns null if the
 * shape is malformed (empty body). Resilience-first: the transport layer
 * doesn't perfect-validate every event, so the bridge does.
 *
 * `convId` is the network-native `from` (see file-level docs). The caller's
 * `addConversation` path will normalize hex inputs to lowercase x-only at the
 * UI boundary; values that arrive here from Matrix / SSB are kept verbatim.
 */
export function projectIncoming(dm: IncomingDM): Message | null {
  if (!dm || typeof dm.plaintext !== "string" || dm.plaintext === "") {
    return null;
  }
  if (typeof dm.from !== "string" || dm.from === "") return null;
  // Hex senders (Nostr) get lowercased so conversation lookup matches the
  // canonical x-only form Herald uses everywhere else. Non-hex senders
  // (Matrix MXID, SSB feed id) pass through unchanged.
  const convId = /^[0-9a-fA-F]{64}$/.test(dm.from)
    ? dm.from.toLowerCase()
    : dm.from;
  // Aegis DM ts is seconds; messages persist ms.
  const ts = dm.ts * 1000;
  return {
    id: dm.id,
    convId,
    body: dm.plaintext,
    ts,
    mine: false,
    status: "received",
    via: dm.network,
  };
}

async function ensureConversation(
  pubkey: string,
  ts: number,
): Promise<void> {
  const existing = await getConversation(pubkey);
  if (existing) return;
  await saveConversation({
    pubkey,
    createdAt: ts,
    lastMessageAt: ts,
  });
}
