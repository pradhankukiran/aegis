/**
 * Scribe — incoming share-invite bridge.
 *
 * When a peer shares a note with us they (will) publish an Aegis event of
 * type `scribe.share-invite` whose payload identifies the Matrix room
 * carrying the CRDT updates and, optionally, an initial wrapped key. The
 * Scribe page would surface this as a notification: "<peer> shared a note
 * with you — open?".
 *
 * # v1 status
 *
 * The notifications UI doesn't exist yet (Wave 4a deferred), and the
 * receiving end of the CRDT loop needs a live Matrix homeserver to verify.
 * So this module ships as a stub: it subscribes via `AegisTransport.subscribe`
 * and logs incoming invites with a TODO. The hook surface is the same one
 * the future "real" notification path will use — flip the console.log to
 * "push to a notification queue" once the UI lands and the integration
 * tests have a real transport to exercise.
 *
 * Live-infra-only items deferred to the docker-stack tier:
 *   - Verifying that the Matrix `subscribe` call actually delivers the event.
 *   - Joining the indicated room and binding a Yjs CRDT to it.
 *   - Persisting "I joined this shared note" state across reloads.
 */

import type { AegisEvent, AegisTransport } from "../transport";

/** Aegis logical type for a Scribe share invite. */
export const SCRIBE_SHARE_INVITE_TYPE = "scribe.share-invite";

/**
 * Expected payload shape of a share invite. `senderHint` is informational;
 * the AegisEvent carries the authoritative sender id in `ev.sender`.
 */
export type ScribeShareInvite = {
  noteId: string;
  roomId: string;
  /** Optional human-readable hint at the time of share. */
  senderHint?: string;
};

/**
 * Attach the share-invite listener. Returns the unsubscribe closure handed
 * back by the transport — callers must hold onto it for cleanup.
 *
 * `onInvite` is invoked once per unique share invite (the transport
 * facade's `subscribe` dedups by AegisEvent id). v1 callers don't supply
 * one; the stub logs and returns. The hook layer can pass a real callback
 * once the UI exists.
 */
export function attachShareInviteBridge(
  transport: AegisTransport,
  onInvite?: (invite: ScribeShareInvite, ev: AegisEvent) => void,
): () => void {
  return transport.subscribe({ type: SCRIBE_SHARE_INVITE_TYPE }, (ev) => {
    const invite = projectInvite(ev);
    if (!invite) return;
    if (onInvite) {
      try {
        onInvite(invite, ev);
      } catch (err) {
        console.error("[scribe] share-invite handler error:", err);
      }
      return;
    }
    // TODO(live-infra): hand to the notifications queue once it exists.
    // For v1 we just log so devtools surfaces the event.
    console.info("[scribe] share-invite received (no handler):", {
      from: ev.sender,
      origin: ev.origin,
      ...invite,
    });
  });
}

/**
 * Project a raw AegisEvent into a typed ScribeShareInvite. Returns null on
 * malformed payloads — the transport layer doesn't perfect-validate every
 * event, so the bridge does.
 */
export function projectInvite(ev: AegisEvent): ScribeShareInvite | null {
  if (!ev || ev.type !== SCRIBE_SHARE_INVITE_TYPE) return null;
  const c = ev.content as { noteId?: unknown; roomId?: unknown; senderHint?: unknown } | null;
  if (!c) return null;
  if (typeof c.noteId !== "string" || c.noteId === "") return null;
  if (typeof c.roomId !== "string" || c.roomId === "") return null;
  const senderHint =
    typeof c.senderHint === "string" && c.senderHint !== ""
      ? c.senderHint
      : undefined;
  return {
    noteId: c.noteId,
    roomId: c.roomId,
    ...(senderHint ? { senderHint } : {}),
  };
}
