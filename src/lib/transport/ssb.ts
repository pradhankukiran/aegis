/**
 * Aegis SSB transport — browser side of the WebSocket bridge to ssb-pub.
 *
 * ## Path choice (Path B — pragmatic JSON-over-WS shim)
 *
 * The SSB ecosystem is largely abandoned for browser use:
 *   - `ssb-browser-core` last released 2023-01, no PRs since.
 *   - The full secret-handshake (SHS) + muxrpc stack is unstable in the browser
 *     (sodium-native polyfill maze, pull-stream Node-shim hell, ESM/CJS
 *     dual-package hazards on every transitive dep).
 *
 * Aegis owns both ends of this pipe (the client AND the ssb-pub container in
 * `infra/docker/ssb-pub/`). So we trade "pure SSB peer" for "shippable bridge"
 * and speak a thin JSON-over-WebSocket protocol from the browser to a small
 * server in the pub. The pub translates our JSON calls to muxrpc on the
 * ssb-server side. Plan §2 already accepts this trade-off ("WS bridge to a
 * pub"), and aegis-networks-decisions.md §SSB confirms it as the chosen path.
 *
 * Trade-offs:
 *   + No fragile SHS in the browser.
 *   + No heavyweight ssb-* deps in the browser bundle.
 *   - We are a *gateway client*, not a true SSB peer. Offline mesh between
 *     two browsers (without the pub) is a future concern; v1 talks to a pub.
 *
 * ## Identity / Ed25519 derivation
 *
 * SSB uses Ed25519 keys; Aegis identity is secp256k1. We derive a
 * deterministic Ed25519 keypair from the master identity:
 *
 *     ikm   = identity.seckey                  // 32 bytes
 *     salt  = empty                            // RFC 5869: empty -> all-zero block
 *     info  = "aegis-ssb-ed25519-v1"
 *     seed  = HKDF-SHA256(ikm, salt, info, 32) // 32 bytes
 *     edSk  = seed                             // RFC 8032 secret key
 *     edPk  = ed25519.getPublicKey(edSk)       // 32 bytes
 *     ssbId = "@" + base64(edPk) + ".ed25519"
 *
 * Reproducible from the same Identity. Independent of Nostr / Matrix paths so
 * a future key-rotation policy on one network does not perturb the others.
 *
 * Note: HKDF here uses `@noble/hashes/hkdf`, NOT `src/lib/crypto/kdf.ts`
 * (which is Argon2id for password stretching).
 *
 * ## Wire protocol (JSON-over-WS) — see `infra/docker/ssb-pub/index.js`
 *
 * Frames are JSON text messages, each with a top-level `op` field.
 *
 * Server → client on connect:
 *   {op:"hello", challenge: <base64url-32-random-bytes>}
 *
 * Client → server (auth):
 *   {op:"auth", ssb_id, ed_pubkey, challenge_sig}
 *     - challenge_sig = ed25519.sign(challenge_bytes, edSk), base64url-encoded
 * Server → client:
 *   {op:"auth_ok"} | {op:"err", id?, code, message}
 *
 * Client → server (publish):
 *   {op:"publish", id, content}
 * Server → client:
 *   {op:"publish_ok", id, msg_id, sequence}
 *
 * Client → server (subscribe):
 *   {op:"subscribe", id, author?: "@..."}
 * Server → client (one per matching feed message):
 *   {op:"msg", sub_id, msg: SSBMessage}
 *
 * Client → server (unsubscribe):
 *   {op:"unsubscribe", id, sub_id}
 *
 * Both sides may send:
 *   {op:"err", id?, code, message}
 *   {op:"close"}                  // request remote-side teardown
 *
 * `id` is a per-call correlation id (string). Subscription ids are returned
 * by the client when it issues `subscribe` and reused on every `msg` reply.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import { deriveSharedKey, peerPubkeyBytesFromHex } from "../crucible/ecdh";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  utf8Decode,
  utf8Encode,
} from "../crypto/encoding";
import { decryptBytes, encryptBytes } from "../crypto/symmetric";
import type { Identity } from "../identity";

// --- Types --------------------------------------------------------------------

/**
 * A single feed-log entry as returned by the pub.
 *
 * Mirrors the canonical SSB message envelope. The pub fills in `author`,
 * `sequence`, `timestamp`, and `signature`; the client only ever supplies
 * `content`.
 */
export type SSBMessage = {
  /** Message hash, e.g. `%abcd...=.sha256`. */
  key: string;
  value: {
    /** Feed id of the author, e.g. `@base64.ed25519`. */
    author: string;
    sequence: number;
    timestamp: number;
    content: unknown;
    signature: string;
  };
};

/** Subscription filter. Empty = all messages from all feeds the pub knows. */
export type SubscribeOpts = {
  author?: string;
};

/** Callback invoked once per matching feed message during a subscription. */
export type SSBMessageHandler = (msg: SSBMessage) => void;

// --- Wire frames (internal) --------------------------------------------------

type ServerHello = { op: "hello"; challenge: string };
type ServerAuthOk = { op: "auth_ok" };
type ServerPublishOk = {
  op: "publish_ok";
  id: string;
  msg_id: string;
  sequence: number;
};
type ServerSubscribeOk = { op: "subscribe_ok"; id: string };
type ServerMsg = { op: "msg"; sub_id: string; msg: SSBMessage };
type ServerErr = { op: "err"; id?: string; code: string; message: string };
type ServerClose = { op: "close" };

type ServerFrame =
  | ServerHello
  | ServerAuthOk
  | ServerPublishOk
  | ServerSubscribeOk
  | ServerMsg
  | ServerErr
  | ServerClose;

// --- Module-level helpers ----------------------------------------------------

const HKDF_INFO = utf8Encode("aegis-ssb-ed25519-v1");

/* ---------------------------------------------------------------------------
 * SSB DM content encryption (SEC-003).
 *
 * Aegis SSB DMs are end-to-end encrypted on the content layer, even though
 * SSB private boxes (`crypto_box_seal` / `crypto_box_easy`) are deferred to
 * a later phase. The CEK is derived via ECDH on the sender + recipient
 * master secp256k1 identities (the same keypair Crucible uses, but with a
 * domain-separated HKDF info), so peer pubkey + own seckey is all either
 * side needs to seal or open a message.
 *
 * Residual leak: the ssb-pub sees the author + recipient pubkey, just not
 * the body. Phase 6+ will swap this for libsodium boxes.
 * ------------------------------------------------------------------------ */

/** HKDF info string for the SSB DM CEK. Domain-separated from Crucible. */
const SSB_DM_KDF_INFO = utf8Encode("aegis-ssb-dm-v1");
/** AAD bound into the SSB DM XChaCha20-Poly1305 envelope. */
const SSB_DM_AAD = utf8Encode("aegis:ssb-dm:v=1");

/**
 * Derive the symmetric content-encryption key for an SSB DM between
 * `seckey` (ours) and `peerPubkey` (the counterparty). Both sides compute
 * the same CEK when each uses (own seckey, other's pubkey) — that's the
 * symmetry property of ECDH.
 *
 * Internally: re-uses `crucible/ecdh.ts#deriveSharedKey` (which does the
 * ECDH + HKDF over the SEC1 x-coord with the Crucible v1 info string),
 * then HKDF-extracts again with `aegis-ssb-dm-v1` to rebind the info.
 * That makes a Crucible-derived CEK and an SSB DM CEK provably distinct
 * even when both involve the same secp256k1 keypair.
 */
function deriveSsbDmCek(seckey: Uint8Array, peerPubkey: Uint8Array): Uint8Array {
  if (seckey.length !== 32) {
    throw new Error("deriveSsbDmCek: seckey must be 32 bytes");
  }
  // `deriveSharedKey` normalizes 32→33 internally, so any valid pubkey
  // form works here.
  const crucibleCek = deriveSharedKey(seckey, peerPubkey);
  return hkdf(sha256, crucibleCek, undefined, SSB_DM_KDF_INFO, 32);
}

/**
 * Encrypt an SSB DM body. Returns the base64url-encoded ciphertext.
 *
 * Content is encrypted, but the ssb-pub sees author + recipient. Switch
 * to ssb-private boxes when wired (Phase 6+).
 */
export async function sealSsbDm(
  identity: Identity,
  toPubkeyHex: string,
  plaintext: string,
): Promise<string> {
  const peer = peerPubkeyBytesFromHex(toPubkeyHex);
  const cek = deriveSsbDmCek(identity.seckey, peer);
  try {
    const ciphertext = await encryptBytes(
      cek,
      utf8Encode(plaintext),
      SSB_DM_AAD,
    );
    return bytesToBase64Url(ciphertext);
  } finally {
    cek.fill(0);
  }
}

/**
 * Decrypt an SSB DM body. Returns null on any failure (malformed
 * ciphertext, wrong-key CEK, wrong AAD) so callers can drop silently
 * without leaking an oracle.
 *
 * Content is encrypted, but the ssb-pub sees author + recipient. Switch
 * to ssb-private boxes when wired (Phase 6+).
 */
export async function openSsbDm(
  identity: Identity,
  fromPubkeyHex: string,
  sealedB64: string,
): Promise<string | null> {
  let peer: Uint8Array;
  try {
    peer = peerPubkeyBytesFromHex(fromPubkeyHex);
  } catch {
    return null;
  }
  let cek: Uint8Array;
  try {
    cek = deriveSsbDmCek(identity.seckey, peer);
  } catch {
    return null;
  }
  try {
    let ciphertext: Uint8Array;
    try {
      ciphertext = base64UrlToBytes(sealedB64);
    } catch {
      return null;
    }
    const plain = await decryptBytes(cek, ciphertext, SSB_DM_AAD).catch(
      () => null,
    );
    return plain ? utf8Decode(plain) : null;
  } finally {
    cek.fill(0);
  }
}

/**
 * Derive a deterministic Ed25519 keypair from the master identity.
 * Exposed for tests and any other internal subsystem that needs the same id.
 */
export function deriveEd25519FromIdentity(identity: Identity): {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
} {
  if (!identity?.seckey || identity.seckey.length !== 32) {
    throw new Error(
      "deriveEd25519FromIdentity: identity.seckey must be 32 bytes",
    );
  }
  // RFC 5869: salt may be omitted; HKDF-Extract treats it as a zeroed block of HashLen.
  const seed = hkdf(sha256, identity.seckey, undefined, HKDF_INFO, 32);
  const publicKey = ed25519.getPublicKey(seed);
  // The `ed25519.sign(...)` API in @noble/curves@2 expects the raw 32-byte seed
  // as the secret key, and re-derives the SHA-512 expansion internally.
  return { secretKey: seed, publicKey };
}

/** Format an Ed25519 public key as the canonical SSB feed id. */
export function ssbIdFromEd25519PubKey(pub: Uint8Array): string {
  if (pub.length !== 32) {
    throw new Error("ssbIdFromEd25519PubKey: public key must be 32 bytes");
  }
  // SSB historically uses standard base64 (with '+' and '/'). To stay url-safe
  // across our codebase we use base64url; the pub accepts both forms.
  return `@${bytesToBase64Url(pub)}.ed25519`;
}

// --- Class -------------------------------------------------------------------

type PendingCall = {
  resolve: (value: ServerFrame) => void;
  reject: (err: Error) => void;
};

type Subscription = {
  id: string;
  handler: SSBMessageHandler;
};

const READY_STATES = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

/**
 * Browser ↔ ssb-pub WebSocket bridge.
 *
 * Lifecycle:
 *   1. `new SSBTransport(identity, pubUrl)` — derives the SSB id; no I/O.
 *   2. `await transport.connect()` — opens the WS, completes auth handshake.
 *   3. `await transport.publish(content)` — append to your own feed.
 *      `transport.subscribe(opts, onMsg)` — receive feed events.
 *   4. `await transport.close()` — clean shutdown.
 *
 * Re-connection is the caller's concern in v1 (Aegis upper layers manage the
 * lifetime). The class is single-shot: after `close()` build a new instance.
 */
export class SSBTransport {
  /** SSB feed id, e.g. `@<base64-of-edPk>.ed25519`. */
  public readonly ssbId: string;

  /**
   * Aegis identity pubkey in 66-char SEC1-compressed hex form (parity-byte
   * prefix + 32-byte x). This is the form `AegisTransport.directMessage`
   * routes through to SSB as the `to` field on `aegis-dm` messages.
   */
  public readonly identityPubkeyHex: string;
  /**
   * Aegis identity pubkey in 64-char x-only hex form (parity byte stripped).
   * Accepted as an alternate `to` target for robustness with peers that
   * normalize before sending.
   */
  public readonly identityPubkeyHexXOnly: string;

  private readonly pubUrl: string;
  private readonly edSk: Uint8Array;
  private readonly edPk: Uint8Array;
  /**
   * Stored so `subscribeIncomingDMs` can derive an ECDH CEK to decrypt
   * incoming SSB DM ciphertext (SEC-003). The seckey scalar is sensitive
   * — it never crosses the wire here.
   */
  private readonly aegisIdentity: Identity;

  private ws: WebSocket | null = null;
  private nextCallId = 1;
  private nextSubId = 1;
  private readonly pending = new Map<string, PendingCall>();
  private readonly subscriptions = new Map<string, Subscription>();
  private connecting: Promise<void> | null = null;
  private closed = false;

  constructor(identity: Identity, pubUrl: string) {
    if (!pubUrl) {
      throw new Error("SSBTransport: pubUrl is required");
    }
    const { secretKey, publicKey } = deriveEd25519FromIdentity(identity);
    this.edSk = secretKey;
    this.edPk = publicKey;
    this.ssbId = ssbIdFromEd25519PubKey(publicKey);
    this.pubUrl = pubUrl;
    this.aegisIdentity = identity;
    // Cache both compressed and x-only hex forms of the master identity pubkey
    // so `subscribeIncomingDMs` can match either when filtering `to`.
    const fullHex = bytesToHex(identity.pubkey);
    this.identityPubkeyHex = fullHex;
    this.identityPubkeyHexXOnly = fullHex.length === 66 ? fullHex.slice(2) : fullHex;
  }

  /**
   * Open the WebSocket and complete the auth handshake.
   * Idempotent for concurrent callers — returns the same in-flight Promise.
   */
  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error("SSBTransport: cannot connect a closed instance");
    }
    if (this.ws && this.ws.readyState === READY_STATES.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = this.openSocket()
      .then(() => undefined)
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  /** Append a message to your own feed. */
  async publish(content: object): Promise<{ id: string; sequence: number }> {
    this.assertOpen();
    const id = this.allocCallId();
    const reply = (await this.call({ op: "publish", id, content })) as
      | ServerPublishOk
      | ServerErr;
    if (reply.op === "err") throw asError(reply, "publish failed");
    return { id: reply.msg_id, sequence: reply.sequence };
  }

  /**
   * Subscribe to feed messages.
   *
   * Returns an unsubscribe function. Calling it sends `unsubscribe` to the pub
   * and stops invoking the local handler. Unsubscribing twice is a no-op.
   */
  subscribe(opts: SubscribeOpts, onMsg: SSBMessageHandler): () => void {
    this.assertOpen();
    const id = this.allocSubId();
    this.subscriptions.set(id, { id, handler: onMsg });
    // Fire-and-forget: surface failures by setting `onerror` on the WS — but
    // never throw here, callers expect synchronous return.
    this.sendFrame({
      op: "subscribe",
      id,
      ...(opts.author ? { author: opts.author } : {}),
    });

    let dropped = false;
    return () => {
      if (dropped) return;
      dropped = true;
      this.subscriptions.delete(id);
      // If the socket has already gone away, no need to send the cleanup.
      if (this.ws && this.ws.readyState === READY_STATES.OPEN) {
        this.sendFrame({ op: "unsubscribe", id, sub_id: id });
      }
    };
  }

  /**
   * Subscribe to incoming Aegis DMs that arrive on the SSB feed.
   *
   * # Wire shape (SEC-003)
   *
   * Aegis SSB DMs are end-to-end encrypted at the content layer:
   *
   *     {
   *       type: "aegis-dm",
   *       to:   <recipient pubkey hex>,
   *       from: <sender pubkey hex>,    // secp256k1, for ECDH
   *       sealed: <base64url ciphertext>,
   *       ephemeral: false
   *     }
   *
   * Encryption uses XChaCha20-Poly1305 with a CEK derived via ECDH between
   * the sender's master secp256k1 seckey and the recipient's pubkey, with
   * HKDF info `aegis-ssb-dm-v1` and AAD `aegis:ssb-dm:v=1`. See
   * `transport/index.ts#sealSsbDm` / `openSsbDm` for the canonical
   * implementation.
   *
   * **Residual metadata leak**: content is encrypted, but the ssb-pub sees
   * author + recipient. Switch to ssb-private boxes when wired (Phase 6+).
   *
   * # Targeting model
   *
   *   - `to === this.ssbId`              → SSB-native feed-id targeting.
   *   - `to === this.identityPubkeyHex`  → 66-char SEC1 compressed hex
   *     (what `AegisTransport.directMessage` writes today).
   *   - `to === this.identityPubkeyHexXOnly` → 64-char x-only hex variant.
   *
   * Anything else with a string `to` is "targeted but not at us" and
   * skipped. Self-authored events are skipped so the sender's own publish
   * doesn't bounce back through this channel.
   *
   * Pre-SEC-003 plaintext events (no `sealed` field, payload was a raw
   * string) are silently dropped — readers can't make sense of them
   * anyway because we now require an authenticated ECDH envelope.
   *
   * Returns the wrapped `subscribe` unsubscribe closure.
   */
  subscribeIncomingDMs(
    onIncoming: (dm: {
      from: string;
      plaintext: string;
      ts: number;
      eventId: string;
    }) => void,
  ): () => void {
    return this.subscribe({}, (m) => {
      // Skip our own messages — the pub may echo our published feed back
      // through any subscription that doesn't specify an author filter.
      if (m.value.author === this.ssbId) return;
      const content = m.value.content as
        | {
            type?: string;
            to?: string | null;
            from?: unknown;
            sealed?: unknown;
            payload?: unknown;
          }
        | undefined;
      if (!content || content.type !== "aegis-dm") return;
      // Accept a targeted `to` that maps to one of our identity
      // representations (see method docs). Encrypted envelopes always carry
      // an explicit `to`; broadcast plaintext (the pre-SEC-003 shape) is
      // no longer accepted because we wouldn't be able to decrypt it.
      if (typeof content.to !== "string") return;
      const t = content.to;
      const matchesUs =
        t === this.ssbId ||
        t === this.identityPubkeyHex ||
        t === this.identityPubkeyHexXOnly;
      if (!matchesUs) return;

      // Require sealed + from. Pre-SEC-003 events carried `payload: string`
      // (plaintext) instead. We deliberately drop those rather than try to
      // surface them — they couldn't have been authentically authored by
      // a current Aegis client.
      const sealed = content.sealed;
      const fromHex = content.from;
      if (typeof sealed !== "string" || typeof fromHex !== "string") return;

      // Asynchronously derive the CEK and decrypt. We can't await inside
      // the synchronous handler, so kick off a fire-and-forget promise.
      // Decryption failures are silent — they almost always mean the
      // message wasn't authored by the claimed `from` (sig+AAD verify
      // failed) or wasn't for us.
      const ts = Math.floor((m.value.timestamp ?? Date.now()) / 1000);
      void openSsbDm(this.aegisIdentity, fromHex, sealed).then((plaintext) => {
        if (plaintext === null) return;
        onIncoming({
          from: m.value.author,
          plaintext,
          ts,
          eventId: m.key,
        });
      });
    });
  }

  /** Tear down the WebSocket and reject any in-flight calls. */
  async close(): Promise<void> {
    this.closed = true;
    const ws = this.ws;
    this.subscriptions.clear();
    for (const [, p] of this.pending) {
      p.reject(new Error("SSBTransport: closed"));
    }
    this.pending.clear();
    if (!ws) return;
    if (ws.readyState === READY_STATES.OPEN) {
      try {
        ws.send(JSON.stringify({ op: "close" }));
      } catch {
        // socket might already be tearing down — ignore.
      }
    }
    if (
      ws.readyState !== READY_STATES.CLOSED &&
      ws.readyState !== READY_STATES.CLOSING
    ) {
      ws.close(1000, "client close");
    }
    this.ws = null;
  }

  // ---- internals ----------------------------------------------------------

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.pubUrl);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        this.ws = null;
        reject(err);
      };

      ws.addEventListener("error", () => {
        fail(new Error("SSBTransport: websocket error"));
      });

      ws.addEventListener("close", (ev: CloseEvent) => {
        if (!settled) {
          fail(
            new Error(
              `SSBTransport: websocket closed before auth (code ${ev.code})`,
            ),
          );
          return;
        }
        // post-handshake close: cancel pending calls and subscriptions
        this.handleSocketClose(ev);
      });

      ws.addEventListener("message", (ev: MessageEvent) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(typeof ev.data === "string" ? ev.data : "")
            ;
        } catch {
          fail(new Error("SSBTransport: malformed JSON frame"));
          return;
        }

        // Handshake phase: first frame must be `hello`. We respond with `auth`.
        if (!settled) {
          if (frame.op === "hello") {
            this.handleHello(frame as ServerHello).then(
              () => {
                /* keep waiting for auth_ok */
              },
              (err) => fail(err instanceof Error ? err : new Error(String(err))),
            );
            return;
          }
          if (frame.op === "auth_ok") {
            settled = true;
            resolve();
            return;
          }
          if (frame.op === "err") {
            fail(asError(frame, "auth failed"));
            return;
          }
          fail(
            new Error(
              `SSBTransport: unexpected pre-auth frame op="${
                (frame as { op?: string }).op
              }"`,
            ),
          );
          return;
        }

        this.dispatch(frame);
      });
    });
  }

  private async handleHello(frame: ServerHello): Promise<void> {
    const challenge = base64UrlToBytes(frame.challenge);
    // ed25519.sign(message, secretKey) — `secretKey` here is the 32-byte HKDF seed.
    const sig = ed25519.sign(challenge, this.edSk);
    this.sendFrame({
      op: "auth",
      ssb_id: this.ssbId,
      ed_pubkey: bytesToBase64Url(this.edPk),
      challenge_sig: bytesToBase64Url(sig),
    });
  }

  private dispatch(frame: ServerFrame): void {
    switch (frame.op) {
      case "msg": {
        const sub = this.subscriptions.get(frame.sub_id);
        if (sub) {
          try {
            sub.handler(frame.msg);
          } catch (err) {
            // handler errors are user-code; log via `err` channel and continue.
            // We don't have a logger plumbed in here yet — keep silent so we
            // don't spam the console. Aegis-level error surfaces are TBD.
            void err;
          }
        }
        return;
      }
      case "publish_ok":
      case "subscribe_ok":
      case "err": {
        const id = (frame as { id?: string }).id;
        if (id && this.pending.has(id)) {
          const p = this.pending.get(id)!;
          this.pending.delete(id);
          p.resolve(frame);
        }
        return;
      }
      case "close": {
        // server requested teardown
        this.close().catch(() => {
          /* ignore */
        });
        return;
      }
      default:
        // unknown op: ignore (forward-compat).
        return;
    }
  }

  private handleSocketClose(ev: CloseEvent): void {
    const reason = `websocket closed (code ${ev.code})`;
    for (const [, p] of this.pending) {
      p.reject(new Error(`SSBTransport: ${reason}`));
    }
    this.pending.clear();
    this.subscriptions.clear();
    this.ws = null;
  }

  private sendFrame(frame: object): void {
    if (!this.ws || this.ws.readyState !== READY_STATES.OPEN) {
      throw new Error("SSBTransport: socket not open");
    }
    this.ws.send(JSON.stringify(frame));
  }

  private call(
    frame: Record<string, unknown> & { id: string },
  ): Promise<ServerFrame> {
    return new Promise<ServerFrame>((resolve, reject) => {
      this.pending.set(frame.id, { resolve, reject });
      try {
        this.sendFrame(frame);
      } catch (err) {
        this.pending.delete(frame.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SSBTransport: already closed");
    if (!this.ws || this.ws.readyState !== READY_STATES.OPEN) {
      throw new Error("SSBTransport: not connected — call connect() first");
    }
  }

  private allocCallId(): string {
    return `c${this.nextCallId++}`;
  }

  private allocSubId(): string {
    return `s${this.nextSubId++}`;
  }
}

function asError(frame: ServerErr, fallback: string): Error {
  const err = new Error(`${frame.message || fallback} [${frame.code}]`);
  (err as Error & { code?: string }).code = frame.code;
  return err;
}
