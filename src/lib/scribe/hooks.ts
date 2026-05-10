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
import {
  deleteNote as deleteNoteFromStore,
  loadActiveNotes,
  loadNote,
  saveNote,
} from "./storage";
import type { Note, NoteDraft } from "./types";

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
 *  - `save`     seal current draft + persist + publish SSB marker. Returns
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
      const updated: Note = {
        id: current.id,
        title: current.title,
        contentEnvelope: envelope,
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
        ...(prior?.sharedRoomId ? { sharedRoomId: prior.sharedRoomId } : {}),
      };
      await saveNote(updated);
      // SSB marker is best-effort; publishSaveMarker swallows errors.
      void publishSaveMarker(transport, updated.id, updated.updatedAt);
      setNote(updated);
      setBaseline({
        id: updated.id,
        title: updated.title,
        content: current.content,
      });
      noteRef.current = updated;
      onSavedRef.current?.();
      return updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return null;
    } finally {
      setSaving(false);
    }
  }, [masterKey, transport]);

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
        return note;
      } finally {
        setCreating(false);
      }
    },
    [masterKey, transport],
  );

  return { create, creating };
}

/* -------------------------------------------------------------------------- */
/* useDeleteNote                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Returns a `remove(id)` that soft-deletes the row in IndexedDB (tombstone)
 * and best-effort publishes an `aegis-note-deleted` marker on SSB. The
 * tombstone keeps the cross-device sync path correct — see
 * `storage.ts#deleteNote` and `feed.ts#publishDeleteMarker`.
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
        // Best-effort SSB marker; publishDeleteMarker swallows its own errors.
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
 * Set up the Matrix-side scaffolding for a shared note.
 *
 * v1 behaviour:
 *   1. Call `transport.matrix.createRoom({ name: "aegis-note-<id>",
 *      encrypted: true })`.
 *   2. Stamp the returned `room_id` onto the note's persisted row as
 *      `sharedRoomId`.
 *   3. Return the room id so the UI can show "shared" indicator + the room
 *      id (in monospace, for monitoring during dev).
 *
 * What's deliberately not wired in v1 (live-infra deferred):
 *   - The actual Yjs↔Matrix update sync. We'd hook `doc.on("update")` to
 *     publish encoded updates, and join the room to apply incoming updates.
 *     Both ends need a real homeserver to verify.
 *   - Share-invite events to specific peers. The Matrix room is private with
 *     no invitees in v1; future work invites the peer's MXID and emits an
 *     AegisEvent of type `scribe.share-invite`.
 */
export function useShareNote(
  id: string | null,
  transport: AegisTransport | null,
): {
  share: () => Promise<string | null>;
  sharing: boolean;
  isShared: boolean;
  sharedRoomId: string | null;
  error: string | null;
} {
  const [sharing, setSharing] = useState(false);
  const [sharedRoomId, setSharedRoomId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Track the persisted state when the id changes. setState always goes
  // through a .then boundary (matches the Herald pattern + satisfies the
  // react-hooks/set-state-in-effect rule).
  useEffect(() => {
    let cancelled = false;
    if (!id) {
      Promise.resolve().then(() => {
        if (!cancelled) setSharedRoomId(null);
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
      })
      .catch(() => {
        if (cancelled) return;
        setSharedRoomId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const share = useCallback(async (): Promise<string | null> => {
    if (!id) return null;
    if (!transport) {
      setError("transport not connected");
      return null;
    }
    setSharing(true);
    setError(null);
    try {
      const roomId = await transport.matrix.createRoom({
        name: "aegis-note-" + id,
        encrypted: true,
      });
      const existing = await loadNote(id);
      if (!existing) {
        throw new Error("note not found");
      }
      const updated: Note = { ...existing, sharedRoomId: roomId };
      await saveNote(updated);
      setSharedRoomId(roomId);
      return roomId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      return null;
    } finally {
      setSharing(false);
    }
  }, [id, transport]);

  return {
    share,
    sharing,
    isShared: sharedRoomId !== null,
    sharedRoomId,
    error,
  };
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
