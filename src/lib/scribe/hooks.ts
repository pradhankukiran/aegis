"use client";

/**
 * Scribe — React hooks layered on top of envelope, storage, feed, crdt.
 *
 * ## Lifecycle
 *
 * The page lifecycle mirrors Herald's:
 *
 *   useIdentity()       → reuse Herald's hook to load the identity.
 *   useTransport(id)    → reuse Herald's hook to build the AegisTransport.
 *   useNotes()          → live list of notes (sorted desc by updatedAt).
 *   useNote(id)         → live { note, draft, setDraft, save, isDirty } for
 *                         the open note.
 *   useShareNote(id)    → create a Matrix room scaffold + stamp sharedRoomId
 *                         onto the persisted note.
 *
 * Encryption boundary lives in `useNote.save()` and the initial unwrap step
 * inside `useNote`. The hooks never expose plaintext to storage or non-React
 * callers — `note.contentEnvelope` is the only thing that crosses the IDB
 * boundary.
 *
 * Hooks that touch IndexedDB defer to `useEffect`, never run during SSR, and
 * gate every read on `typeof indexedDB !== "undefined"`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Identity } from "../identity";
import type { AegisTransport } from "../transport";

import {
  deriveMasterKey,
  unwrapNoteContent,
  wrapNoteContent,
} from "./envelope";
import { publishDeleteMarker, publishSaveMarker } from "./feed";
import { persistNote } from "./persistence";
import {
  deleteNote as deleteNoteFromStore,
  loadActiveNotes,
  loadNote,
  saveNote,
} from "./storage";
import type { Note, NoteDraft } from "./types";
import { attachMatrixSync, getDoc, setText as setDocText } from "./crdt";
import { pubkeyHex } from "../identity";
import { mxidFromPubkeyHex } from "../transport/matrix";

/* -------------------------------------------------------------------------- */
/* useNotes                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Live notes list. Maintained as React state — `refresh()` re-reads from
 * IndexedDB after any mutation. Sorted desc by `updatedAt` at the storage
 * layer.
 *
 * Filters out soft-deleted tombstones (rows with `deletedMarker === true`)
 * via `loadActiveNotes` so the UI never renders a deleted note. The
 * tombstones still exist in IDB so cross-device sync can pick them up; see
 * `storage.ts` for the tombstone shape.
 */
export function useNotes(): {
  notes: Note[];
  refresh: () => Promise<void>;
} {
  const [notes, setNotes] = useState<Note[]>([]);

  const refresh = useCallback((): Promise<void> => {
    if (typeof indexedDB === "undefined") return Promise.resolve();
    return loadActiveNotes().then((list) => {
      setNotes(list);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (typeof indexedDB === "undefined") return;
    loadActiveNotes().then((list) => {
      if (cancelled) return;
      setNotes(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { notes, refresh };
}

/* -------------------------------------------------------------------------- */
/* useNote                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Live editor state for a single note.
 *
 *  - `note`     the persisted shape (envelope only); null until the initial
 *               unwrap completes or if `id` doesn't resolve.
 *  - `draft`    the working plaintext copy; mutated via `setDraft`.
 *  - `setDraft` partial mutator — accepts a `Partial<NoteDraft>` so the UI
 *               can update title or content independently.
 *  - `save`     seal current draft + persist + publish save marker (no-op
 *               post-SSB; reserved for future feed channel). Returns
 *               the new `Note` row.
 *  - `isDirty`  draft differs from the most recently saved snapshot.
 *  - `loading`  true until the initial unwrap settles.
 *  - `error`    last seen unwrap/save error, or null. Surfaced by the UI.
 */
export function useNote(
  id: string | null,
  identity: Identity | null,
  transport: AegisTransport | null,
  onSaved?: () => void,
): {
  note: Note | null;
  draft: NoteDraft | null;
  setDraft: (partial: Partial<NoteDraft>) => void;
  save: () => Promise<Note | null>;
  isDirty: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
} {
  const [note, setNote] = useState<Note | null>(null);
  const [draft, setDraftState] = useState<NoteDraft | null>(null);
  // The most recently saved (or freshly unwrapped) snapshot — used to
  // compute `isDirty` without making the comparison ambiguous about whose
  // content is "current truth".
  const [baseline, setBaseline] = useState<NoteDraft | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Hold the latest values in refs so `save` can read them without forcing
  // every keystroke to recreate the callback (and the rest of the render
  // tree downstream).
  const draftRef = useRef<NoteDraft | null>(null);
  const noteRef = useRef<Note | null>(null);
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    onSavedRef.current = onSaved;
  }, [onSaved]);

  // Derive the master key once per identity. Returned as `undefined` if
  // identity is null so callers can short-circuit.
  const masterKey = useMemo<Uint8Array | null>(() => {
    if (!identity) return null;
    return deriveMasterKey(identity);
  }, [identity]);

  // Initial load: read the row, unwrap content, seed draft + baseline.
  //
  // All setState calls flow through a Promise boundary (.then on either
  // loadNote or Promise.resolve()) so the lint rule's "no sync setState in
  // an effect body" is satisfied — same pattern Herald uses to keep cascade-
  // render warnings from firing while still letting an external system
  // (IndexedDB) drive React state.
  useEffect(() => {
    let cancelled = false;
    if (!id || !masterKey) {
      Promise.resolve().then(() => {
        if (cancelled) return;
        setNote(null);
        setDraftState(null);
        setBaseline(null);
        setLoading(false);
        setError(null);
        noteRef.current = null;
        draftRef.current = null;
      });
      return () => {
        cancelled = true;
      };
    }
    if (typeof indexedDB === "undefined") return;
    // Loading/error are React-state side effects of the IDB read kicking
    // off. Defer to the same microtask boundary so the lint contract holds.
    Promise.resolve().then(() => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
    });
    loadNote(id).then(
      async (row) => {
        if (cancelled) return;
        try {
          if (!row) {
            setNote(null);
            setDraftState(null);
            setBaseline(null);
            noteRef.current = null;
            draftRef.current = null;
            return;
          }
          const content = await unwrapNoteContent(
            masterKey,
            row.contentEnvelope,
          );
          if (cancelled) return;
          const initial: NoteDraft = {
            id: row.id,
            title: row.title,
            content,
          };
          setNote(row);
          setDraftState(initial);
          setBaseline(initial);
          noteRef.current = row;
          draftRef.current = initial;
        } catch (err) {
          if (cancelled) return;
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
        } finally {
          if (!cancelled) setLoading(false);
        }
      },
      (err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, masterKey]);

  const setDraft = useCallback((partial: Partial<NoteDraft>) => {
    setDraftState((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...partial };
      draftRef.current = next;
      return next;
    });
  }, []);

  const save = useCallback(async (): Promise<Note | null> => {
    const current = draftRef.current;
    if (!current || !masterKey) return null;
    setSaving(true);
    setError(null);
    try {
      const now = Date.now();
      const envelope = await wrapNoteContent(masterKey, current.content);
      const prior = noteRef.current;
      // Carry every prior field forward (share state, Pinata CID, ...)
      // and overwrite only the bits that the save changed.
      const updated: Note = {
        ...(prior ?? { createdAt: now }),
        id: current.id,
        title: current.title,
        contentEnvelope: envelope,
        updatedAt: now,
      };
      await saveNote(updated);
      // publishSaveMarker is a no-op post-SSB removal; retained as a hook
      // for the future feed-channel reintroduction.
      void publishSaveMarker(transport, updated.id, updated.updatedAt);
      setNote(updated);
      setBaseline({
        id: updated.id,
        title: updated.title,
        content: current.content,
      });
      noteRef.current = updated;
      onSavedRef.current?.();
      // Best-effort Pinata mirror. We don't block the user-facing save UI on
      // the cloud round-trip — if it lands, the IDB row is updated with the
      // CID via a follow-up `saveNote`; if it fails (or 503/unconfigured),
      // local-only persistence stands. `identity` is required to sign the
      // upload-URL request.
      if (identity) {
        void persistNote(updated, identity)
          .then(async (res) => {
            if (res.mode === "uploaded") {
              try {
                await saveNote(res.note);
                if (noteRef.current?.id === res.note.id) {
                  noteRef.current = res.note;
                  setNote(res.note);
                }
              } catch (err) {
                console.warn(
                  "[scribe] failed to write Pinata CID back to IDB:",
                  err,
                );
              }
            }
          })
          .catch((err) => {
            // Non-503 errors land here. The save itself already succeeded
            // locally; the Pinata mirror is best-effort.
            console.warn("[scribe] Pinata mirror upload failed:", err);
          });
      }
      return updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return null;
    } finally {
      setSaving(false);
    }
  }, [identity, masterKey, transport]);

  const isDirty = useMemo<boolean>(() => {
    if (!draft || !baseline) return false;
    return draft.title !== baseline.title || draft.content !== baseline.content;
  }, [draft, baseline]);

  return {
    note,
    draft,
    setDraft,
    save,
    isDirty,
    loading,
    saving,
    error,
  };
}

/* -------------------------------------------------------------------------- */
/* useCreateNote                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Returns a `create(initialContent?)` that mints a fresh note id, seals an
 * empty content envelope, persists the row, and resolves with the new note.
 *
 * Splitting create from `useNote` keeps the load/edit hook focused on a
 * single id — the page composes "create, then select" via the returned id.
 */
export function useCreateNote(
  identity: Identity | null,
  transport: AegisTransport | null,
): {
  create: (initial?: { title?: string; content?: string }) => Promise<Note | null>;
  creating: boolean;
} {
  const [creating, setCreating] = useState(false);
  const masterKey = useMemo<Uint8Array | null>(() => {
    if (!identity) return null;
    return deriveMasterKey(identity);
  }, [identity]);

  const create = useCallback(
    async (initial?: { title?: string; content?: string }): Promise<Note | null> => {
      if (!masterKey) return null;
      setCreating(true);
      try {
        const now = Date.now();
        const content = initial?.content ?? "";
        const title = initial?.title?.trim() || "Untitled note";
        const envelope = await wrapNoteContent(masterKey, content);
        const note: Note = {
          id: mintNoteId(),
          title,
          contentEnvelope: envelope,
          createdAt: now,
          updatedAt: now,
        };
        await saveNote(note);
        void publishSaveMarker(transport, note.id, note.updatedAt);
        // Best-effort Pinata mirror; same shape as the save flow. The
        // initial CID is written back to IDB so subsequent saves carry it.
        if (identity) {
          void persistNote(note, identity)
            .then(async (res) => {
              if (res.mode === "uploaded") {
                try {
                  await saveNote(res.note);
                } catch (err) {
                  console.warn(
                    "[scribe] failed to write initial Pinata CID:",
                    err,
                  );
                }
              }
            })
            .catch((err) => {
              console.warn("[scribe] Pinata mirror create-upload failed:", err);
            });
        }
        return note;
      } finally {
        setCreating(false);
      }
    },
    [identity, masterKey, transport],
  );

  return { create, creating };
}

/* -------------------------------------------------------------------------- */
/* useDeleteNote                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Returns a `remove(id)` that soft-deletes the row in IndexedDB (tombstone).
 * Also calls `publishDeleteMarker`, which is a no-op post-SSB (the future
 * feed channel will pick this hook up). See `storage.ts#deleteNote` and
 * `feed.ts#publishDeleteMarker`.
 */
export function useDeleteNote(
  transport: AegisTransport | null = null,
): {
  remove: (id: string) => Promise<void>;
  removing: boolean;
} {
  const [removing, setRemoving] = useState(false);
  const remove = useCallback(
    async (id: string): Promise<void> => {
      setRemoving(true);
      try {
        await deleteNoteFromStore(id);
        // publishDeleteMarker is a no-op post-SSB; retained for the future
        // feed-channel reintroduction.
        void publishDeleteMarker(transport, id);
      } finally {
        setRemoving(false);
      }
    },
    [transport],
  );
  return { remove, removing };
}

/* -------------------------------------------------------------------------- */
/* useShareNote                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Set up the Matrix-side scaffolding for a shared note + fan out share
 * invites to specific recipients.
 *
 * Behaviour:
 *   1. Resolve recipient pubkeys → Matrix MXIDs via the same derivation
 *      `MatrixTransport` uses (first 24 hex chars of the x-only pubkey as
 *      localpart + the transport's homeserver domain). The MXID list is
 *      passed to `createRoom` as initial `invite` so the homeserver
 *      bootstraps Megolm sessions for the peers immediately.
 *   2. Create the Matrix room (encrypted, private). Returned `roomId`.
 *   3. Stamp `{ sharedRoomId, sharedWith, sharedAt }` onto the note row +
 *      persist locally + mirror to Pinata so cross-device the share state
 *      is recoverable.
 *   4. For each recipient, send a direct-message handshake with
 *      `{ type: "aegis.scribe.share-invite", noteId, sharedRoomId,
 *      pinataCid }` so the peer's device can join the room + load the
 *      envelope from Pinata. `directMessage` uses the Matrix → Nostr
 *      fallback chain — it works whichever network the peer is on.
 *
 * `share` can be invoked without `withPubkeys` to create an "open" shared
 * room (no invitees) — useful as a checkpoint before the user types in
 * recipient handles. Calling again with recipients adds them by sending
 * additional share-invite DMs (the room itself stays the same).
 *
 * Live-infra deferred items (the Yjs ↔ Matrix sync loop) live in `crdt.ts`
 * via `attachMatrixSync`. The hook layer wires that up via the editor
 * component when a note is shared.
 */
export function useShareNote(
  id: string | null,
  identity: Identity | null,
  transport: AegisTransport | null,
): {
  share: (withPubkeys?: string[]) => Promise<string | null>;
  sharing: boolean;
  isShared: boolean;
  sharedRoomId: string | null;
  sharedWith: string[];
  error: string | null;
} {
  const [sharing, setSharing] = useState(false);
  const [sharedRoomId, setSharedRoomId] = useState<string | null>(null);
  const [sharedWith, setSharedWith] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Track the persisted state when the id changes. setState always goes
  // through a .then boundary (matches the Herald pattern + satisfies the
  // react-hooks/set-state-in-effect rule).
  useEffect(() => {
    let cancelled = false;
    if (!id) {
      Promise.resolve().then(() => {
        if (cancelled) return;
        setSharedRoomId(null);
        setSharedWith([]);
      });
      return () => {
        cancelled = true;
      };
    }
    if (typeof indexedDB === "undefined") return;
    loadNote(id)
      .then((row) => {
        if (cancelled) return;
        setSharedRoomId(row?.sharedRoomId ?? null);
        setSharedWith(row?.sharedWith ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setSharedRoomId(null);
        setSharedWith([]);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const share = useCallback(
    async (withPubkeys: string[] = []): Promise<string | null> => {
      if (!id) return null;
      if (!transport) {
        setError("transport not connected");
        return null;
      }
      if (!identity) {
        setError("identity not loaded");
        return null;
      }
      setSharing(true);
      setError(null);
      try {
        // Validate every recipient pubkey shape up front so we don't
        // half-create the room. `pubkeyHex` from MXID derivation expects
        // 66 hex chars (SEC1-compressed) — match that here.
        const cleanRecipients: string[] = [];
        for (const raw of withPubkeys) {
          const trimmed = (raw ?? "").trim();
          if (!trimmed) continue;
          if (!/^[0-9a-fA-F]{66}$/.test(trimmed)) {
            throw new Error(
              "share: recipient pubkey must be 66 hex chars (SEC1-compressed)",
            );
          }
          cleanRecipients.push(trimmed.toLowerCase());
        }
        // Derive MXIDs from the recipient pubkeys. We reuse the canonical
        // helper in the Matrix transport so the localpart derivation can
        // never drift between scribe-side invitees and DM-side recipients.
        const domain = matrixDomain(transport);
        const invitees = cleanRecipients.map((pk) =>
          mxidFromPubkeyHex(pk, domain),
        );
        const existing = await loadNote(id);
        if (!existing) {
          throw new Error("note not found");
        }
        // If the row already has a sharedRoomId we reuse it; new
        // recipients become additional invitees via subsequent DMs.
        let roomId = existing.sharedRoomId ?? null;
        if (!roomId) {
          roomId = await transport.matrix.createRoom({
            name: existing.title || ("aegis-note-" + id),
            encrypted: true,
            invitees: invitees.length > 0 ? invitees : undefined,
          });
        }
        const now = Date.now();
        // Merge new recipients with the existing list, de-duped.
        const mergedWith = Array.from(
          new Set<string>([
            ...(existing.sharedWith ?? []),
            ...cleanRecipients,
          ]),
        );
        const updated: Note = {
          ...existing,
          sharedRoomId: roomId,
          sharedWith: mergedWith,
          sharedAt: existing.sharedAt ?? now,
        };
        await saveNote(updated);

        // Best-effort Pinata mirror — the share-invite payload below
        // carries the CID so the peer can fetch + decrypt the current
        // envelope state. If Pinata isn't configured, we still send the
        // invite (the room exists; the peer will pick up live edits via
        // CRDT once they join).
        const senderHint = pubkeyHex(identity);
        let cid: string | undefined = updated.pinataCid;
        try {
          const res = await persistNote(updated, identity);
          if (res.mode === "uploaded") {
            await saveNote(res.note);
            cid = res.note.pinataCid;
          }
        } catch (err) {
          console.warn(
            "[scribe] share: Pinata mirror failed (continuing):",
            err,
          );
        }

        // Fan out share-invite directMessages. Each is best-effort — a
        // single peer's failure must not block the others.
        for (const pk of cleanRecipients) {
          const payload = JSON.stringify({
            type: SCRIBE_SHARE_INVITE_MSGTYPE,
            noteId: id,
            sharedRoomId: roomId,
            ...(cid ? { pinataCid: cid } : {}),
            from: senderHint,
          });
          void transport.directMessage(pk, payload).catch((err) => {
            console.warn(
              "[scribe] share-invite directMessage failed for " +
                pk.slice(0, 8) +
                ":",
              err,
            );
          });
        }

        setSharedRoomId(roomId);
        setSharedWith(mergedWith);
        return roomId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        return null;
      } finally {
        setSharing(false);
      }
    },
    [id, identity, transport],
  );

  return {
    share,
    sharing,
    isShared: sharedRoomId !== null,
    sharedRoomId,
    sharedWith,
    error,
  };
}

/**
 * Logical message type for the share-invite DM payload. The receiving end
 * (the `transport-bridge` module) projects it back into a `ScribeShareInvite`.
 */
const SCRIBE_SHARE_INVITE_MSGTYPE = "aegis.scribe.share-invite";

/**
 * Extract the Matrix homeserver domain from the transport. We dip into
 * `transport.matrix.mxid` (always `@localpart:domain`) rather than the raw
 * homeserver URL because `mxid` is the public-facing getter and is what
 * the underlying MXID derivation uses for "domain".
 */
function matrixDomain(transport: AegisTransport): string {
  const mxid = transport.matrix.mxid;
  const colon = mxid.indexOf(":");
  if (colon < 0) {
    throw new Error("share: transport.matrix.mxid missing domain");
  }
  return mxid.slice(colon + 1);
}

/* -------------------------------------------------------------------------- */
/* useSharedNoteSync                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Bind the Yjs↔Matrix sync for a shared note, returning the live `Y.Doc`
 * and a function the editor uses to mutate text. Returns `null` for the
 * doc when the note isn't shared or the transport isn't connected — the
 * editor falls back to plain-text mode in that case.
 *
 * The doc is seeded from the most recent `draft.content` so the local view
 * matches what's already on disk; subsequent edits flow through the doc.
 */
export function useSharedNoteSync(
  noteId: string | null,
  sharedRoomId: string | null,
  transport: AegisTransport | null,
  seedContent: string | null,
): {
  doc: import("yjs").Doc | null;
  text: string;
  setText: (next: string) => void;
} {
  type YDoc = import("yjs").Doc;
  const [doc, setDoc] = useState<YDoc | null>(null);
  const [text, setTextState] = useState<string>("");

  const docRef = useRef<YDoc | null>(null);
  // Hold the seed in a ref so a parent that re-renders with a changing
  // `seedContent` (e.g. every keystroke updates `draft.content`) doesn't
  // tear down the matrix sync. The seed is only read on first attach.
  const seedRef = useRef<string | null>(seedContent);
  useEffect(() => {
    seedRef.current = seedContent;
  }, [seedContent]);

  useEffect(() => {
    if (!noteId || !sharedRoomId || !transport) {
      Promise.resolve().then(() => {
        setDoc(null);
        setTextState("");
      });
      docRef.current = null;
      return;
    }
    const d = getDoc(noteId);
    docRef.current = d;
    // Seed the doc with the most recent seed only on first attach for
    // this note (length 0 means we've never seen the doc before in this
    // session). Subsequent mounts pick up the in-memory state.
    const yText = d.getText("content");
    const seed = seedRef.current;
    if (yText.length === 0 && seed && seed.length > 0) {
      d.transact(() => {
        yText.insert(0, seed);
      });
    }
    // Observe text changes so React re-renders. Yjs's `observe` fires
    // after every transaction commit, both local and remote.
    const onChange = () => {
      setTextState(yText.toString());
    };
    yText.observe(onChange);
    // Initial render — push the current state into React.
    Promise.resolve().then(() => {
      setDoc(d);
      setTextState(yText.toString());
    });
    const detachSync = attachMatrixSync(d, transport, sharedRoomId);
    return () => {
      try {
        yText.unobserve(onChange);
      } catch {
        /* no-op */
      }
      detachSync();
    };
  }, [noteId, sharedRoomId, transport]);

  const setText = useCallback((next: string) => {
    const d = docRef.current;
    if (!d) return;
    setDocText(d, next);
  }, []);

  return { doc, text, setText };
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Mint a note id. Uses `crypto.randomUUID()` when available, falls back to
 * a random-stem string for older runtimes (same pattern Herald uses for
 * message ids). Note ids are IDB primary keys, not security-sensitive.
 */
export function mintNoteId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return (
    Math.random().toString(16).slice(2) +
    "-" +
    Date.now().toString(16) +
    "-" +
    Math.random().toString(16).slice(2)
  );
}

/** Format a Unix-ms timestamp as a short relative label. */
export function formatRelative(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  const sec = Math.round(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Derive a sensible title from a body of markdown — first non-empty line,
 * stripped of leading `#` characters. Used as the placeholder title when
 * the user starts typing in a fresh note without setting one explicitly.
 */
export function deriveTitleFromContent(content: string): string {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const stripped = line.replace(/^#+\s*/, "").trim();
    if (stripped) return stripped.slice(0, 80);
  }
  return "Untitled note";
}
