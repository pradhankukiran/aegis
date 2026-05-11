"use client";

/**
 * Herald — `/herald` route. The first real Aegis feature.
 *
 * Lifecycle:
 *
 *   1. Mount → useIdentity loads from IndexedDB.
 *      - No identity:  render <IdentityPanel /> with "Generate" CTA. After
 *                      generation the hook re-renders us with the new id.
 *      - Has identity: continue.
 *   2. useTransport(id) builds an AegisTransport and connects to every
 *      configured network. Status is reflected in the header badges.
 *   3. useIncomingBridge subscribes to aegis.message events; each one is
 *      persisted to IndexedDB and triggers a refresh of the active
 *      conversation's message list.
 *   4. User adds conversations, picks one, sends/receives messages.
 *
 * matrix-js-sdk is heavy (WASM, IndexedDB, sync loop) — the dynamic import
 * inside useTransport keeps it off the SSR pass and out of the initial
 * client bundle.
 */
import { useCallback, useState } from "react";
import { MessageSquare } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { Watermark } from "@/components/layout/watermark";

import {
  pubkeyHex,
} from "@/lib/identity";
import {
  truncatePubkey,
  useConversations,
  useIdentity,
  useIncomingBridge,
  useMessages,
  useSendMessage,
  useTransport,
} from "@/lib/herald";
import type { Message } from "@/lib/herald";

import { AddConversationDialog } from "@/components/herald/AddConversationDialog";
import { ChatPane } from "@/components/herald/ChatPane";
import { ConversationList } from "@/components/herald/ConversationList";
import { IdentityPanel } from "@/components/herald/IdentityPanel";
import { NetworkStatusBadges } from "@/components/herald/NetworkStatusBadges";

export default function HeraldPage() {
  const { identity, ready: identityReady, generate } = useIdentity();

  // Identity gate. Render a centered "loading" placeholder while we check
  // IndexedDB so we don't flash the CTA on every reload of an existing user.
  if (!identityReady) {
    return (
      <main className="relative z-10 flex flex-1 flex-col">
        <Watermark />
        <PageHeader
          icon={MessageSquare}
          eyebrow="Phase 3"
          title="Herald"
          description="Loading identity…"
          spot="herald"
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
          icon={MessageSquare}
          eyebrow="Phase 3"
          title="Herald"
          description="Real-time end-to-end encrypted chat across Matrix, Nostr, and SSB."
          spot="herald"
        />
        <IdentityPanel identity={null} onGenerate={generate} />
      </main>
    );
  }

  return <HeraldChat identity={identity} regenerate={generate} />;
}

function HeraldChat({
  identity,
  regenerate,
}: {
  identity: NonNullable<ReturnType<typeof useIdentity>["identity"]>;
  regenerate: () => Promise<typeof identity>;
}) {
  void regenerate; // reserved for a future "regenerate" affordance
  const { transport, status, ready: transportReady } = useTransport(identity);
  const {
    conversations,
    addConversation,
    refresh: refreshConversations,
  } = useConversations();
  // User-chosen pubkey (null until they click one). Effective selection is
  // computed below — if the user hasn't picked anything yet but a list
  // exists, we surface the most recent conversation as the active one.
  // Putting the auto-select in the render path (instead of an effect) keeps
  // it derived, avoids the cascading-render warning, and means the chat
  // pane shows content immediately on first paint after a reload.
  const [userSelected, setUserSelected] = useState<string | null>(null);
  const selectedPubkey: string | null =
    userSelected ?? conversations[0]?.pubkey ?? null;
  const {
    messages,
    refresh: refreshMessages,
    appendOptimistic,
    patch,
  } = useMessages(selectedPubkey);

  // Wire inbound transport events to the store + the visible message list.
  // Whenever a message lands, refresh the conversation list (so a new pubkey
  // surfaces in the rail) and, if it belongs to the open conversation,
  // refresh its message list so it appears immediately.
  const onIncomingMessage = useCallback(
    (m: Message) => {
      void refreshConversations();
      if (m.convId === selectedPubkey) {
        void refreshMessages();
      }
    },
    [selectedPubkey, refreshConversations, refreshMessages],
  );
  useIncomingBridge(transport, onIncomingMessage);

  const { send, sending } = useSendMessage(transport, selectedPubkey, {
    appendOptimistic,
    patch,
  });

  const handleAdd = useCallback(
    async (pubkey: string) => {
      const c = await addConversation(pubkey);
      setUserSelected(c.pubkey);
    },
    [addConversation],
  );

  return (
    <main className="relative z-10 flex flex-1 flex-col">
      <Watermark />
      <PageHeader
        icon={MessageSquare}
        eyebrow="Phase 3"
        title="Herald"
        description={`You are ${truncatePubkey(pubkeyHex(identity))} · end-to-end encrypted across Matrix, Nostr, and SSB.`}
        spot="herald"
      />
      <div className="flex items-center justify-between gap-3 border-b-2 border-foreground bg-background px-4 py-3 sm:px-6">
        <NetworkStatusBadges status={status} />
        <AddConversationDialog onAdd={handleAdd} />
      </div>
      <div className="grid flex-1 grid-cols-1 overflow-hidden md:grid-cols-[280px_1fr]">
        <ConversationList
          conversations={conversations}
          selectedPubkey={selectedPubkey}
          onSelect={setUserSelected}
        />
        <ChatPane
          conversationPubkey={selectedPubkey}
          messages={messages}
          onSend={send}
          sending={sending}
          composeDisabled={!transportReady}
        />
      </div>
    </main>
  );
}
