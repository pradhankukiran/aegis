/**
 * Aegis Matrix transport — wraps `matrix-js-sdk@41` with Rust crypto (Vodozemac
 * via `@matrix-org/matrix-sdk-crypto-wasm`).
 *
 * ## Identity → MXID derivation
 *
 *   localpart = first 24 hex chars of the compressed-secp256k1 public key
 *               (skipping the 0x02/0x03 prefix byte → 24 hex chars of the x
 *               coordinate gives 12 bytes / 96 bits of entropy, plenty unique
 *               for portfolio-scale Aegis users while comfortably fitting
 *               under Matrix's 255-char localpart cap).
 *   MXID      = `@<localpart>:<domain-from-homeserver-url>`
 *
 * The domain is parsed from the `homeserver` URL passed to the constructor —
 * if you connect to `https://matrix.aegis.app`, your MXID is
 * `@<localpart>:matrix.aegis.app`. Override is intentional: this lets a power
 * user with their own homeserver run Aegis without touching the code.
 *
 * ## Crypto
 *
 * matrix-js-sdk 41 ships **only Rust crypto**. We call `initRustCrypto()` with
 * `useIndexedDB: true` so Vodozemac state survives reloads. The WASM blob lives
 * in `@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.wasm`
 * (resolved via `import.meta.url`). Next.js 16 + Turbopack picks up the file
 * automatically; `transpilePackages` in `next.config.ts` covers the few CJS-y
 * subpaths matrix-js-sdk still ships.
 *
 * ## Login flow
 *
 *  1. If the caller has a stored access token (from a previous session, kept
 *     in IndexedDB under `aegis-matrix-session` — see SEC-002), reuse it via
 *     `createClient({ accessToken, userId, deviceId })`.
 *  2. Otherwise, POST `{ username, password }` to `/api/matrix/register`,
 *     where the server proxies the homeserver's `m.login.registration_token`
 *     UIA flow. The registration token lives ONLY in
 *     `AEGIS_MATRIX_REGISTRATION_TOKEN` (server-side) — never in the client
 *     bundle (SEC-004). The route returns the access token + device id,
 *     which we persist to IndexedDB.
 *
 * Cross-signing / SAS device verification is deferred to Phase 4 polish —
 * Phase 2 ships single-device only.
 *
 * IMPORTANT: this module is browser-only (`"use client"` at every call site).
 * It touches `IndexedDB`, `WebSocket`, and the Vodozemac WASM, all of which
 * trip server bundling.
 */

import {
  Preset,
  RoomEvent,
  Visibility,
  createClient,
  type ICreateRoomOpts,
  type MatrixClient,
  type MatrixEvent as SdkMatrixEvent,
  type Room,
} from "matrix-js-sdk";

import { bytesToHex } from "../crypto/encoding";
import type { Identity } from "../identity";

import {
  clearMatrixSession,
  loadMatrixSession,
  saveMatrixSession,
} from "./matrix-session-store";

/**
 * Path to our server-side registration proxy. The browser POSTs the
 * pubkey-derived `username` here and the route forwards to the homeserver
 * with the secret `AEGIS_MATRIX_REGISTRATION_TOKEN` we hold server-only.
 * See SEC-004 in `docs/security-notes.md`.
 */
const REGISTER_PROXY_PATH = "/api/matrix/register";

/** The number of hex chars from the pubkey to use as the MXID localpart. */
const LOCALPART_HEX_CHARS = 24;

/** A decoded (or, for `m.room.encrypted`, still-encrypted) Matrix event. */
export type MatrixEvent = {
  /** Server-assigned event ID, e.g. `$abc...:domain`. */
  eventId: string;
  /** Room the event belongs to. */
  roomId: string;
  /** MXID of the sender, e.g. `@abcd1234...:matrix.aegis.app`. */
  sender: string;
  /** Decrypted event type, e.g. `m.room.message`. */
  type: string;
  /** Decrypted event content. (For events still being decrypted, this is the
   * wire payload; downstream code should `event.isBeingDecrypted()` and wait.) */
  content: unknown;
  /** Origin server timestamp (ms since epoch). */
  origin: number;
};

/** Options accepted by {@link MatrixTransport.connect}. */
export type ConnectOpts = {
  /**
   * Deprecated — left in for backwards compatibility with the per-feature
   * hook code that still threads a (no-longer-bundled) token through. The
   * registration token is now held server-side as
   * `AEGIS_MATRIX_REGISTRATION_TOKEN` and consumed by
   * `/api/matrix/register`; this field is ignored by `connect()`.
   *
   * Will be removed once every hook drops its read of
   * `NEXT_PUBLIC_AEGIS_MATRIX_REGISTRATION_TOKEN` (the field used to come
   * from there — see SEC-004).
   */
  registrationToken?: string;
};

/** Options accepted by {@link MatrixTransport.createRoom}. */
export type CreateRoomOpts = {
  name?: string;
  /** MXIDs of users to invite at room creation time. */
  invitees?: string[];
  /** Whether to enable Megolm encryption on the room. */
  encrypted: boolean;
};

/** Options accepted by {@link MatrixTransport.subscribe}. */
export type SubscribeOpts = {
  /** If set, only events in this room are dispatched to the callback. */
  roomId?: string;
};

/** A function that, when called, removes the previously-installed listener. */
export type Unsubscribe = () => void;

/**
 * Browser-side Aegis Matrix client.
 *
 * Use one instance per identity. Lifecycle:
 *
 *   const t = new MatrixTransport(id, "https://matrix.aegis.app");
 *   await t.connect({ registrationToken: "..." });
 *   await t.initCrypto();
 *   ... t.sendMessage / t.subscribe / ...
 *   await t.close();
 */
export class MatrixTransport {
  private readonly identity: Identity;
  private readonly homeserver: string;
  private readonly domain: string;
  private readonly localpart: string;
  private readonly _mxid: string;

  private client: MatrixClient | null = null;
  private cryptoReady = false;
  private connected = false;

  /**
   * Construct a transport instance. Does not perform any I/O — call
   * {@link connect} to log in/register and {@link initCrypto} to bootstrap
   * Vodozemac.
   */
  constructor(identity: Identity, homeserver: string) {
    this.identity = identity;
    this.homeserver = trimTrailingSlash(homeserver);
    this.domain = parseHomeserverDomain(this.homeserver);
    this.localpart = deriveLocalpart(identity);
    this._mxid = `@${this.localpart}:${this.domain}`;
  }

  /** The MXID the transport will operate as, e.g. `@abcd...:matrix.aegis.app`. */
  get mxid(): string {
    return this._mxid;
  }

  /**
   * Establish a connection to the homeserver — either by reusing a stored
   * access token, or by registering a fresh account via the server-side
   * `/api/matrix/register` proxy. The proxy holds the registration token
   * server-only (SEC-004); the browser never sees it.
   *
   * The `opts.registrationToken` field is ignored — kept only for type
   * compatibility with hook call sites pending their migration.
   *
   * Idempotent: calling twice is a no-op after the first success.
   */
  async connect(opts: ConnectOpts = {}): Promise<void> {
    // `opts.registrationToken` is intentionally ignored — kept on the
    // type only for backwards compatibility with hook callers. See
    // ConnectOpts docs (SEC-004).
    void opts;
    if (this.connected) return;
    ensureBrowser();

    const stored = await loadMatrixSession();
    let accessToken: string | null = stored?.accessToken ?? null;
    let deviceId: string | null = stored?.deviceId ?? null;

    if (!accessToken) {
      const registered = await registerViaProxy(this.localpart);
      accessToken = registered.accessToken;
      deviceId = registered.deviceId ?? "";
      await saveMatrixSession({
        accessToken,
        deviceId: deviceId ?? "",
      });
    }

    if (!accessToken) {
      throw new Error(
        "MatrixTransport.connect: registration succeeded but returned no access_token",
      );
    }

    this.client = createClient({
      baseUrl: this.homeserver,
      accessToken,
      userId: this._mxid,
      ...(deviceId ? { deviceId } : {}),
    });

    this.connected = true;
  }

  /**
   * Initialize Rust (Vodozemac) crypto. Must be called after {@link connect}
   * and **before** {@link startClient}-style operations that decrypt events.
   *
   * Stores Megolm/Olm sessions in IndexedDB so they survive page reloads.
   */
  async initCrypto(): Promise<void> {
    if (this.cryptoReady) return;
    const client = this.requireClient();
    await client.initRustCrypto({ useIndexedDB: true });
    this.cryptoReady = true;
    // Begin syncing once crypto is ready so encrypted timeline events can be
    // decrypted as they arrive.
    await client.startClient({ initialSyncLimit: 20 });
  }

  /**
   * Create a new room. If `encrypted` is true, the room is created with an
   * `m.room.encryption` initial state event so Megolm kicks in immediately.
   */
  async createRoom(opts: CreateRoomOpts): Promise<string> {
    const client = this.requireClient();
    const createOpts: ICreateRoomOpts = {
      name: opts.name,
      visibility: Visibility.Private,
      preset: Preset.PrivateChat,
      invite: opts.invitees,
    };
    if (opts.encrypted) {
      createOpts.initial_state = [
        {
          type: "m.room.encryption",
          state_key: "",
          content: { algorithm: "m.megolm.v1.aes-sha2" },
        },
      ];
    }
    const { room_id } = await client.createRoom(createOpts);
    return room_id;
  }

  /**
   * Send a message event into the given room. `content` should match the
   * shape Matrix expects for the room's message type (typically
   * `{ msgtype: "m.text", body: "..." }`); we do not editorialize.
   */
  async sendMessage(roomId: string, content: object): Promise<string> {
    const client = this.requireClient();
    // matrix-js-sdk's `sendMessage` is typed against a precise
    // RoomMessageEventContent union (msgtype-tagged variants). For a generic
    // transport-layer forwarder we accept any plain object, so cast through a
    // structural type that matches the shorter overload.
    type SendMessageFn = (
      roomId: string,
      content: Record<string, unknown>,
    ) => Promise<{ event_id: string }>;
    const res = await (client.sendMessage as unknown as SendMessageFn)(
      roomId,
      content as Record<string, unknown>,
    );
    return res.event_id;
  }

  /**
   * Listen for live events. The callback receives a normalized
   * {@link MatrixEvent} with decrypted content where possible.
   *
   * Returns an unsubscribe function. Call it to detach the listener.
   */
  subscribe(
    opts: SubscribeOpts,
    onEvent: (e: MatrixEvent) => void,
  ): Unsubscribe {
    const client = this.requireClient();

    // We listen on `Room.timeline` so we get both fresh sync events and
    // back-paginated history. The handler filters by roomId if requested.
    const handler = (
      sdkEvent: SdkMatrixEvent,
      _room: Room | undefined,
      toStartOfTimeline: boolean | undefined,
    ): void => {
      if (toStartOfTimeline) return; // ignore back-pagination
      const evRoomId = sdkEvent.getRoomId();
      if (!evRoomId) return;
      if (opts.roomId && evRoomId !== opts.roomId) return;
      const eventId = sdkEvent.getId();
      const sender = sdkEvent.getSender();
      if (!eventId || !sender) return;
      onEvent({
        eventId,
        roomId: evRoomId,
        sender,
        type: sdkEvent.getType(),
        content: sdkEvent.getContent(),
        origin: sdkEvent.getTs(),
      });
    };

    client.on(RoomEvent.Timeline, handler);
    return () => client.off(RoomEvent.Timeline, handler);
  }

  /**
   * Subscribe to incoming 1:1 DM messages (`m.room.message` events in any
   * room whose membership is exactly {us, them}).
   *
   * Each matching event is normalized to `{ from, plaintext, ts, eventId,
   * roomId }` and handed to `onIncoming`. Notes:
   *   - matrix-js-sdk decrypts encrypted Megolm events before the timeline
   *     emits, so `event.content.body` is already plaintext.
   *   - Events authored by us are skipped (no self-echo for outbound DMs).
   *   - Non-DM rooms (>2 members) are skipped. We don't currently consult
   *     `m.direct` account_data — membership-count is the most reliable
   *     signal for Aegis-internal DM rooms (which we always create with
   *     exactly one invitee).
   *
   * Requires {@link initCrypto} to have completed (or for non-crypto rooms,
   * just {@link connect}). Calling before connect throws.
   *
   * Returns an unsubscribe closure that detaches the timeline listener.
   */
  subscribeIncomingDMs(
    onIncoming: (dm: {
      from: string;
      plaintext: string;
      ts: number;
      eventId: string;
      roomId: string;
    }) => void,
  ): () => void {
    const client = this.requireClient();
    const selfMxid = this._mxid;

    const handler = (
      sdkEvent: SdkMatrixEvent,
      room: Room | undefined,
      toStartOfTimeline: boolean | undefined,
    ): void => {
      if (toStartOfTimeline) return;
      if (sdkEvent.getType() !== "m.room.message") return;
      const sender = sdkEvent.getSender();
      if (!sender || sender === selfMxid) return;
      const roomId = sdkEvent.getRoomId();
      if (!roomId) return;
      // Membership check: 1:1 DM room iff exactly two distinct members and
      // one of them is us.
      const r = room ?? client.getRoom(roomId);
      if (!r) return;
      const memberIds = new Set(r.getMembers().map((m) => m.userId));
      if (memberIds.size !== 2) return;
      if (!memberIds.has(selfMxid)) return;
      const eventId = sdkEvent.getId();
      if (!eventId) return;
      const content = sdkEvent.getContent() as { body?: unknown };
      const body = typeof content?.body === "string" ? content.body : null;
      if (!body) return;
      // origin_server_ts is ms — Aegis DM channel uses unix seconds.
      const ts = Math.floor(sdkEvent.getTs() / 1000);
      onIncoming({ from: sender, plaintext: body, ts, eventId, roomId });
    };

    client.on(RoomEvent.Timeline, handler);
    return () => client.off(RoomEvent.Timeline, handler);
  }

  /**
   * Send a direct message to another Aegis user. Resolves their MXID from the
   * 33-byte compressed pubkey hex, finds-or-creates a 1-to-1 encrypted DM
   * room, and sends a plain `m.text` message.
   *
   * The pubkey hex must be the same form that `pubkeyHex(identity)` returns
   * (66 hex chars: 1-byte SEC1 prefix + 32-byte x).
   */
  async directMessage(toPubkey: string, plaintext: string): Promise<string> {
    const recipient = mxidFromPubkeyHex(toPubkey, this.domain);
    const client = this.requireClient();

    // Look for an existing 1-to-1 with this user that we created before.
    const existingRoomId = findExistingDmRoom(client, recipient, this._mxid);
    const roomId =
      existingRoomId ??
      (await this.createRoom({ invitees: [recipient], encrypted: true }));

    return this.sendMessage(roomId, {
      msgtype: "m.text",
      body: plaintext,
    });
  }

  /** Stop syncing and tear down the underlying client. Idempotent. */
  async close(): Promise<void> {
    if (!this.client) {
      this.connected = false;
      this.cryptoReady = false;
      return;
    }
    try {
      this.client.stopClient();
    } catch {
      // matrix-js-sdk throws if stopClient is called on a non-started client;
      // we don't care.
    }
    this.client = null;
    this.connected = false;
    this.cryptoReady = false;
  }

  /** Internal: return a non-null client or throw if connect() wasn't called. */
  private requireClient(): MatrixClient {
    if (!this.client) {
      throw new Error("MatrixTransport: call connect() before this method");
    }
    return this.client;
  }
}

/* ---------------------------------------------------------------------------
 * MXID derivation
 * --------------------------------------------------------------------------*/

/**
 * Derive the Matrix localpart from an Identity. We hex-encode the public key,
 * strip the SEC1 0x02/0x03 prefix byte (first 2 hex chars), and take the next
 * {@link LOCALPART_HEX_CHARS} hex chars.
 *
 * 24 hex chars = 12 bytes = 96 bits → ~1.4e29 distinct localparts. Probability
 * of collision among 1M Aegis users is well under 2⁻⁴⁰; sufficient for the
 * portfolio scale. If we ever ship a federated production with millions of
 * users we'd switch to the full x-only 64-hex-char localpart (Matrix allows
 * up to 255 chars but warns 18 is the "best practice" cap for human-typed
 * MXIDs — Aegis MXIDs are never human-typed, so 24 is safe).
 */
export function deriveLocalpart(identity: Identity): string {
  const hex = bytesToHex(identity.pubkey);
  // hex[0..2] is the compression prefix (02 / 03). Skip it.
  return hex.slice(2, 2 + LOCALPART_HEX_CHARS);
}

/**
 * Build a full MXID from a 66-char hex pubkey and a Matrix domain.
 * Used by {@link MatrixTransport.directMessage} to address recipients by
 * their Aegis pubkey.
 */
export function mxidFromPubkeyHex(pubkeyHex: string, domain: string): string {
  if (pubkeyHex.length !== 66) {
    throw new Error(
      `mxidFromPubkeyHex: expected 66 hex chars, got ${pubkeyHex.length}`,
    );
  }
  const localpart = pubkeyHex.slice(2, 2 + LOCALPART_HEX_CHARS).toLowerCase();
  return `@${localpart}:${domain}`;
}

/* ---------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------------*/

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function parseHomeserverDomain(homeserver: string): string {
  try {
    return new URL(homeserver).hostname;
  } catch {
    throw new Error(`MatrixTransport: invalid homeserver URL "${homeserver}"`);
  }
}

function ensureBrowser(): void {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") {
    throw new Error("MatrixTransport requires a browser environment");
  }
}

/**
 * Re-export the session-store helpers so callers (e.g. a future "log out
 * of Matrix" button, or tests verifying the round-trip) can manipulate the
 * persisted session without poking IndexedDB directly.
 */
export { clearMatrixSession, loadMatrixSession, saveMatrixSession };

/**
 * Generate a random base64url password to register the account with.
 * Matrix's registration flow wants a password on the wire even when we'll
 * never actually log in with it (we authenticate via the returned access
 * token). Using fresh 32 bytes ensures the password is unguessable even
 * if a future flow surface exposes it.
 *
 * `crypto.getRandomValues` is available in every browser and Edge runtime
 * the Aegis transport currently targets; falling back to a constant string
 * would defeat the point.
 */
function mintRegistrationPassword(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Call our server-side proxy to register a Matrix account. The proxy holds
 * `AEGIS_MATRIX_REGISTRATION_TOKEN` and the homeserver URL; the browser
 * only sees the resulting `{ accessToken, deviceId, mxid }`.
 */
async function registerViaProxy(
  username: string,
): Promise<{ accessToken: string; deviceId: string; mxid: string }> {
  const password = mintRegistrationPassword();
  const res = await fetch(REGISTER_PROXY_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (res.status === 503) {
    let detail: unknown = null;
    try {
      detail = await res.json();
    } catch {
      /* ignore */
    }
    const message =
      detail && typeof (detail as { message?: unknown }).message === "string"
        ? (detail as { message: string }).message
        : "Matrix registration proxy not configured";
    throw new Error(`MatrixTransport.connect: ${message}`);
  }
  if (!res.ok) {
    let detail: unknown = null;
    try {
      detail = await res.json();
    } catch {
      /* ignore */
    }
    const message =
      detail && typeof (detail as { message?: unknown }).message === "string"
        ? (detail as { message: string }).message
        : `proxy returned ${res.status}`;
    throw new Error(`MatrixTransport.connect: registration failed: ${message}`);
  }
  const body = (await res.json()) as {
    accessToken?: unknown;
    deviceId?: unknown;
    mxid?: unknown;
  };
  if (typeof body.accessToken !== "string" || body.accessToken.length === 0) {
    throw new Error(
      "MatrixTransport.connect: registration proxy did not return accessToken",
    );
  }
  return {
    accessToken: body.accessToken,
    deviceId: typeof body.deviceId === "string" ? body.deviceId : "",
    mxid: typeof body.mxid === "string" ? body.mxid : "",
  };
}

/**
 * Look through the locally-known rooms for an existing 1-to-1 DM with
 * `recipientMxid`. We treat a room as a DM if its membership is exactly
 * {us, them} (no other invited or joined members).
 */
function findExistingDmRoom(
  client: MatrixClient,
  recipientMxid: string,
  selfMxid: string,
): string | null {
  for (const room of client.getRooms()) {
    const members = room.getMembers().map((m) => m.userId);
    const set = new Set(members);
    if (set.size !== 2) continue;
    if (set.has(recipientMxid) && set.has(selfMxid)) {
      return room.roomId;
    }
  }
  return null;
}
