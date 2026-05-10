"use client";

/**
 * Scribe — `/scribe` route. The Phase 4 encrypted-notes feature.
 *
 * Lifecycle:
 *
 *   1. Mount → useIdentity (re-used from Herald) loads from IndexedDB.
 *      - No identity:  render <IdentityPanel /> with the same "Generate"
 *                      CTA Herald uses. Identity is shared across features.
 *      - Has identity: continue.
 *   2. useTransport(id) builds an AegisTransport so save-markers can hit
 *      SSB and Share can create Matrix rooms.
 *   3. useNotes + useNote drive the list + editor.
 *   4. Share emits a Matrix room scaffold; CRDT sync is the live-infra path.
 *
 * matrix-js-sdk is heavy (WASM, IndexedDB, sync loop) — `useTransport`'s
 * dynamic import keeps it off SSR. We mirror Herald's pattern verbatim so
 * features stay consistent.
 */

import { useCallback, useEffect, useState } from "react";
import { NotebookPen } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Watermark } from "@/components/layout/watermark";

import { useIdentity, useTransport, truncatePubkey } from "@/lib/herald";
import { pubkeyHex } from "@/lib/identity";
import type { Identity } from "@/lib/identity";

import {
  useCreateNote,
  useDeleteNote,
  useNote,
  useNotes,
  useShareNote,
} from "@/lib/scribe";

import { IdentityPanel } from "@/components/herald/IdentityPanel";

import { EmptyState } from "@/components/scribe/EmptyState";
import { NoteEditor } from "@/components/scribe/NoteEditor";
import { NoteList } from "@/components/scribe/NoteList";
import { NoteToolbar } from "@/components/scribe/NoteToolbar";

export default function ScribePage() {
  const { identity, ready: identityReady, generate } = useIdentity();

  // Identity gate. Render a centered "loading" placeholder while we check
  // IndexedDB so we don't flash the CTA on every reload of an existing user.
  if (!identityReady) {
    return (
      <main className="relative z-10 flex flex-1 flex-col">
        <Watermark />
        <PageHeader
          icon={NotebookPen}
          eyebrow="Phase 4"
          title="Scribe"
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
          icon={NotebookPen}
          eyebrow="Phase 4"
          title="Scribe"
          description="Encrypted notes — personal first, shareable later."
        />
        <IdentityPanel identity={null} onGenerate={generate} />
      </main>
    );
  }

  return <ScribeWorkspace identity={identity} />;
}

function ScribeWorkspace({ identity }: { identity: Identity }) {
  const { transport } = useTransport(identity);
  const { notes, refresh: refreshNotes } = useNotes();
  const { create, creating } = useCreateNote(identity, transport);
  const { remove } = useDeleteNote(transport);

  // Selection: user-chosen id, falling back to the most-recent note so the
  // editor isn't empty on first paint.
  const [userSelected, setUserSelected] = useState<string | null>(null);
  const selectedId: string | null =
    userSelected ?? notes[0]?.id ?? null;

  // Editor state for the selected note. `onSaved` re-syncs the list so the
  // updated `updatedAt` bumps the row to the top.
  const onSaved = useCallback(() => {
    void refreshNotes();
  }, [refreshNotes]);
  const {
    note,
    draft,
    setDraft,
    save,
    isDirty,
    loading,
    saving,
    error,
  } = useNote(selectedId, identity, transport, onSaved);

  const {
    share,
    sharing,
    isShared,
    sharedRoomId,
    error: shareError,
  } = useShareNote(selectedId, transport);

  const handleCreate = useCallback(async () => {
    const fresh = await create();
    if (!fresh) return;
    await refreshNotes();
    setUserSelected(fresh.id);
  }, [create, refreshNotes]);

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    await remove(selectedId);
    await refreshNotes();
    // After deletion, drop the selection so the next render picks the
    // top-most surviving note (or shows the empty state).
    setUserSelected(null);
  }, [selectedId, remove, refreshNotes]);

  // Keep `useShareNote`'s view of the persisted share-state fresh after a
  // save — saving doesn't touch sharedRoomId, but it does rewrite the row.
  // The hook re-reads on id change; we rely on that, so no extra work here.
  useEffect(() => {
    // No-op effect kept as an integration point — future "after-save
    // observers" (e.g. trigger Pinata blob upload) would hook in here.
  }, [note?.updatedAt]);

  const showEmpty = notes.length === 0 && !selectedId;

  return (
    <main className="relative z-10 flex flex-1 flex-col">
      <Watermark />
      <PageHeader
        icon={NotebookPen}
        eyebrow="Phase 4"
        title="Scribe"
        description={`You are ${truncatePubkey(pubkeyHex(identity))} · encrypted notes at rest, shareable via Matrix.`}
      />
      <div className="grid flex-1 grid-cols-1 overflow-hidden md:grid-cols-[280px_1fr]">
        <NoteList
          notes={notes}
          selectedId={selectedId}
          onSelect={setUserSelected}
          onCreate={() => {
            void handleCreate();
          }}
          creating={creating}
        />
        <div className="flex flex-1 flex-col overflow-hidden">
          {showEmpty ? (
            <EmptyState
              onCreate={() => {
                void handleCreate();
              }}
              creating={creating}
            />
          ) : selectedId && draft && note ? (
            <>
              <NoteToolbar
                title={draft.title}
                id={note.id}
                isShared={isShared}
                sharedRoomId={sharedRoomId}
                onShare={share}
                sharing={sharing}
                shareError={shareError}
                onDelete={handleDelete}
              />
              <NoteEditor
                note={note}
                draft={draft}
                setDraft={setDraft}
                save={save}
                saving={saving}
                isDirty={isDirty}
                loading={loading}
                error={error}
              />
            </>
          ) : (
            <NoteEditor
              note={note}
              draft={draft}
              setDraft={setDraft}
              save={save}
              saving={saving}
              isDirty={isDirty}
              loading={loading}
              error={error}
            />
          )}
        </div>
      </div>
    </main>
  );
}
