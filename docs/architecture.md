# Architecture

How Aegis is wired. Top-down: one identity, one transport facade over two networks, seven features that compose on top of both. Every section is keyed to actual file paths in `src/`.

> **SSB note** — Aegis originally shipped a third network leg
> (Scuttlebutt via a thin browser-bridge pub). That pub turned out to be
> unmaintainable in production and has been removed. The transport
> facade now publishes through Matrix + Nostr only. Sections below have
> been updated to match the live shape; offline-mesh resilience (the
> original SSB story) is deferred until a replacement primitive lands.
> The `src/lib/transport/ssb.ts` browser client has been deleted, and
> `infra/docker/ssb-pub/` is preserved on disk but unwired.

---

## Layered model

```
┌──────────────────────────────────────────────────────────────────────┐
│  Feature                                                              │
│  herald  scribe  atlas  witness  beacon  quorum  crucible             │
│  ───────────────────────────────────────────────────────────────────  │
│  Each owns:                                                            │
│   - types.ts             wire shapes + Aegis event-type constants     │
│   - envelope.ts          AAD-bound symmetric encrypt/decrypt          │
│   - store.ts             IndexedDB persistence                        │
│   - transport-bridge.ts  publish / subscribe / decode plumbing        │
│   - hooks.ts             React state surface for the page components  │
└─────────────────────────────────┬────────────────────────────────────┘
                                   │
              ┌────────────────────▼─────────────────────┐
              │  Transport facade (src/lib/transport/)    │
              │  AegisTransport.{publish, subscribe,      │
              │                  subscribeDM, directMessage}
              └──┬──────────────────┬────────────────────┘
                 │                  │
        ┌────────▼───────┐ ┌────────▼────────┐
        │ NostrTransport │ │ MatrixTransport │
        │ nostr-tools    │ │ matrix-js-sdk   │
        │ SimplePool +   │ │ + Vodozemac     │
        │ NIP-44 v2 DMs  │ │ WASM crypto     │
        └────────┬───────┘ └────────┬────────┘
                 │                  │
            wss://relay        https://matrix
            .aegis.app         .aegis.app

              ┌────────────────────────────────────────┐
              │  Crypto primitives (src/lib/crypto/)    │
              │  symmetric · kdf · hash · random ·      │
              │  shamir · timelock · schnorr · halo-prf │
              │  encoding · sodium                       │
              └────────────────────────────────────────┘

              ┌────────────────────────────────────────┐
              │  Identity (src/lib/identity/)           │
              │  secp256k1 master keypair               │
              │  IndexedDB persistence                  │
              │  Portable export/import (v=1 envelope)  │
              └────────────────────────────────────────┘
```

Dependency arrows go downward only: features depend on transport + crypto; transport depends on crypto + identity; crypto is leaf. No feature reaches into another feature's module.

---

## Identity

A single secp256k1 keypair is the user's everything. Generated locally on first run; persisted to IndexedDB on the user's device; never escapes unless the user explicitly exports it.

- **Generation**: `generateIdentity()` in `src/lib/identity/keypair.ts`. Samples 32 random bytes via libsodium's CSPRNG (`src/lib/crypto/random.ts#randomBytes`), then derives the compressed (33-byte SEC1) public point via `@noble/curves/secp256k1.js`.
- **Persistence**: IndexedDB database `aegis`, object store `identity`, primary key `"primary"`. Implementation in `src/lib/identity/storage.ts`. Raw IDB, no wrapper — the access pattern is single-record CRUD.
- **Portable export**: `exportIdentity` / `importIdentity` in `src/lib/identity/portable.ts`. Wire form `aegis:id:v=1:<base64url(JSON.stringify({seckey, createdAt}))>`. The pubkey is re-derived on import — you cannot import a pubkey that does not match its seckey. The blob is unencrypted; users protect it the way they would a master password.

**Cross-network derivation**. The master keypair maps onto each of the two networks deterministically.

| Network | Form | How |
|---|---|---|
| Nostr | x-only 32-byte hex (BIP-340) | Strip the SEC1 parity byte off the compressed pubkey. The x-coordinate alone uniquely determines the BIP-340-canonical (even-Y) point. See `src/lib/transport/nostr.ts` constructor. |
| Matrix | `@<localpart>:<homeserver-domain>` | Localpart = first 24 hex chars of the pubkey's x-coordinate (12 bytes / 96 bits of entropy). Domain is parsed from the homeserver URL. See `src/lib/transport/matrix.ts` `deriveLocalpart`. |

Both derivations are pure functions of the master keypair — restoring the identity on a new device restores both network presences.

---

## Transport facade

One unified surface in `src/lib/transport/index.ts`. Public class `AegisTransport` exposes four primitives:

```ts
class AegisTransport {
  publish(event: AegisEventInput): Promise<PublishResult[]>
  subscribe(filter: AegisFilter, cb: (e: AegisEvent) => void): () => void
  subscribeDM(cb: (dm: IncomingDM) => void): () => void
  directMessage(toPubkeyHex: string, plaintext: string): Promise<...>
}
```

Each method fans across whichever networks are connected.

### AegisEvent id (the dedup key)

Every cross-network event carries a stable identifier:

```
id = sha256(sender + ":" + type + ":" + canonicalize(content))
```

`canonicalize` is JSON-with-recursively-sorted-keys (`canonicalize` exported from `src/lib/transport/index.ts`). The same logical content produces the same id regardless of which network it arrived on or which JS engine serialized it. A 60-second-TTL FIFO map (`DedupCache`) gates the cross-network subscribe callback so identical events delivered by both networks fire the subscriber once.

### Per-network mapping for `aegis.<type>` events

Each Aegis logical event type maps consistently across the two transports.

| Network | Outbound mapping | Notes |
|---|---|---|
| Nostr | NIP-78 (kind 30078 — "Application-specific Data"), `d` tag of `aegis:<type>`, plus an explicit `["aegis-type", <type>]` tag for client-side filtering | NIP-78 is parameterized-replaceable, so callers can carry a single "latest" event per logical type. The `NOSTR_AEGIS_KIND` constant centralizes the kind for future per-type tuning. |
| Matrix | Custom event type `aegis.<type>` inside a topic room aliased `#aegis-<type>:<homeserver-domain>`. Lazily created on first publish, private, encrypted. | As of v1 the topic-room subscription model only sees events the user authored themselves (no invites yet). Multi-author rooms are a Phase 4 enhancement; the inbound decoder is forward-compatible. |

### directMessage fallback chain

Two tries, in order, returning on first success:

1. **Matrix** — encrypted DM room, recipient resolved from pubkey hex via the localpart derivation. Olm 1-to-1 ratchet under the hood.
2. **Nostr** — NIP-44 v2 encrypted content inside `kind 14` (the "Private Direct Message" kind from NIP-17). Not yet wrapped in NIP-59 gift-wrap (metadata privacy) — the inner ciphertext is the same NIP-44 v2 payload either way; the gift-wrap layer is a future enhancement.

If both fail, an aggregate error lists each failure.

### `subscribe` and `subscribeDM`

`subscribe(filter, callback)` opens per-network subscriptions, maps each network's native event shape onto `AegisEvent`, and forwards through the dedup cache to `callback`. `subscribeDM(callback)` is the inbound DM equivalent — each transport decodes its own crypto and delivers an `IncomingDM` with the plaintext body and the sender id in the *origin network's canonical form* (Nostr x-only hex / Matrix MXID). Per the threat-model doc, these are treated as separate addressing spaces until a directory resolver lands.

---

## Per-feature deep dive

### Herald — `/herald` (`src/lib/herald/`)

| Aspect | Detail |
|---|---|
| **Routes** | `/herald` (single page; conversation list + chat pane) |
| **Crypto envelope** | DM-layer only. Matrix Olm 1-to-1 ratchet (primary) → Nostr NIP-44 v2 (fallback). |
| **Storage** | IndexedDB `aegis-herald` with two object stores: `conversations` (keyed on x-only pubkey hex), `messages` (keyed on message id, secondary index on `convId`). `src/lib/herald/store.ts`. |
| **Transport surface** | `AegisTransport.directMessage` (outbound) and `AegisTransport.subscribeDM` (inbound). The Herald `transport-bridge.ts` mints optimistic UUIDs for outbound messages and walks the status state machine `sending → sent / failed`. |
| **Open** | Cross-network `from` form: Nostr DMs surface 64-char x-only hex, Matrix surfaces MXID. Treated as separate addressing spaces in v1; directory resolver is Phase 4. |

### Scribe — `/scribe` (`src/lib/scribe/`)

| Aspect | Detail |
|---|---|
| **Routes** | `/scribe` (note list + editor) |
| **Crypto envelope** | XChaCha20-Poly1305 with AAD `aegis:notes:v=1`. Two-tier: HKDF-SHA256(seckey, info=`aegis-scribe-notes-v1`, 32) → Scribe master key → wraps a fresh per-note 32-byte key → which encrypts the body. `src/lib/scribe/envelope.ts`. |
| **Storage** | IndexedDB `aegis-scribe` for note metadata + encrypted bodies. `src/lib/scribe/storage.ts`. Cross-device sync via Pinata blob persistence is **deferred** in v1 (`src/lib/scribe/feed.ts` publishes save-marker metadata only). |
| **Transport surface** | Save/delete markers are no-ops post-SSB removal — `publishSaveMarker` / `publishDeleteMarker` in `src/lib/scribe/feed.ts` are stubbed for a future feed-channel reintroduction. The encrypted body never crosses the wire in v1; Pinata is the durable mirror. Future shared-notes path: Y.js CRDT updates encrypted per-room key and shipped as `aegis.note.update` custom Matrix events (see `src/lib/scribe/crdt.ts` for the local Y.Doc plumbing). |
| **Open** | Pinata persistence; collaborative-note Matrix room model; CRDT garbage-collection / snapshot cadence. |

### Atlas — `/atlas` (`src/lib/atlas/`)

| Aspect | Detail |
|---|---|
| **Routes** | `/atlas` (map + circle panel + share toggle) |
| **Crypto envelope** | Per-recipient encrypted DM per tick — the per-tick `LocationMessage` envelope `{type: "aegis.location", fix}` is JSON-serialized and shipped via `AegisTransport.directMessage` to each circle member. Each recipient gets a per-DM Olm / NIP-44 ciphertext. No Atlas-specific symmetric envelope. |
| **Storage** | IndexedDB `aegis-atlas` with two stores: circle members (`src/lib/atlas/circle-store.ts`), bounded per-peer position log (`src/lib/atlas/position-store.ts`). |
| **Transport surface** | `AegisTransport.directMessage` for fan-out. `AegisTransport.subscribeDM` filters on `LocationMessage.type === "aegis.location"` for inbound. Tick cadence default 5 minutes (`DEFAULT_SHARE_INTERVAL_MS`). |
| **Open** | Battery profile; tuning cadence based on viewer activity; permission-recovery UX. |

### Witness — `/witness`, `/witness/[hash]` (`src/lib/witness/`)

| Aspect | Detail |
|---|---|
| **Routes** | `/witness` (drop-zone + history), `/witness/[hash]` (verify panel — given a hash, fetch the anchor record and show per-network proof status) |
| **Crypto** | BIP-340 Schnorr signature over `sha256(canonicalize({hash, ts}))`. `src/lib/witness/anchor.ts` — `anchorDigest`, `signAnchor`. Schnorr from `@noble/curves/secp256k1.js`, NOT the `lib/crypto/schnorr.ts` Σ-protocol primitive (which is a different beast). |
| **Storage** | IndexedDB `aegis-witness` for the per-anchor record (`hash`, `sig`, `signer`, `ts`, per-network anchor ids, file metadata). `src/lib/witness/storage.ts`. |
| **Transport surface** | `AegisTransport.publish({type: "aegis.witness", content: {hash, sig, signer, ts}})` fans the anchor out across both networks. The local `AnchorRecord` carries per-network success / failure plus the native event id (Nostr event id / Matrix event id). |
| **Verify** | `src/lib/witness/verify.ts` re-derives the digest, verifies the Schnorr signature, and resolves each per-network anchor id back to the originating event. |
| **Open** | Cross-relay verification (querying for the anchor on networks the verifier hasn't subscribed to). |

### Beacon — `/beacon` (`src/lib/beacon/`)

| Aspect | Detail |
|---|---|
| **Routes** | `/beacon` (list + create + per-beacon detail with countdown) |
| **Crypto envelope** | XChaCha20-Poly1305 with AAD `aegis:beacon:v=1`. Single-tier: a fresh symmetric key encrypts the body; the key is stored alongside the row in IndexedDB. `src/lib/beacon/envelope.ts`. |
| **Trigger architecture** | Two layers: **A (fast path)** — client-side watchdog in `src/lib/beacon/watchdog.ts` polls every 60s and publishes the cleartext `ReleasePayload` when `shouldFire(b)` (`src/lib/beacon/trigger-check.ts`). **B (slow path)** — at create time, the release event is also wrapped via `tlock-js` against the drand quicknet round at `deadline + grace`, and published as `aegis.beacon.timelocked-release` on all three networks. No Vercel Cron required. |
| **Cancellation** | Signed `aegis.beacon.cancelled` event. BIP-340 Schnorr signature over `sha256(canonicalize({beaconId, ts}))`. Observers verify before honouring. `src/lib/beacon/cancel.ts`. |
| **Storage** | IndexedDB `aegis-beacon` for the per-beacon row (id, title, payloadCid, unwrapKeyHex, deadlineUnix, status, etc). `src/lib/beacon/storage.ts`. |
| **Transport surface** | `AegisTransport.publish` for fire / cancel / timelocked-release events. `transport-bridge.ts` subscribes to all three event types and updates local state when remote events arrive (e.g. another device cancelled the beacon). |
| **Pinata** | `src/lib/beacon/pinata-blob.ts` uploads the ciphertext; `payloadCid` is the IPFS hash. Without `PINATA_JWT` configured the create flow degrades to local-only persistence. |
| **Open** | Trustee-quorum trigger — a quorum of trustees forcing the broadcast — is **deferred**. The `Beacon` schema leaves room for it. |

### Quorum — `/quorum`, `/quorum/new`, `/quorum/[pollId]` (`src/lib/quorum/`)

| Aspect | Detail |
|---|---|
| **Routes** | `/quorum` (poll list), `/quorum/new` (create form), `/quorum/[pollId]` (vote pane + tally view) |
| **Crypto envelope** | Sign-then-seal. Inner payload: `{v: 1, vote: {pollId, optionIndex, voter, nonce}, sig: hex(BIP-340-schnorr(seckey, sha256(canonicalize(vote))))}`. Encoded as JSON, then timelock-encrypted via `tlock-js` to the poll's `drandRound`. Wire form is base64url of the armored ciphertext. `src/lib/quorum/seal.ts` + `src/lib/quorum/unseal.ts`. |
| **Drand round** | Computed from the poll's wall-clock `closeUnix` against drand quicknet's `defaultChainInfo`. Same chain hash as Hermetic Echo. `src/lib/quorum/drand.ts`. |
| **Storage** | IndexedDB `aegis-quorum` with stores for polls (keyed on poll id) and ballots (keyed on `[pollId, voter]` — re-submission overwrites). `src/lib/quorum/poll-store.ts`. |
| **Transport surface** | Two event types — `aegis.quorum.poll` (metadata; public) and `aegis.quorum.ballot` (sealed). Ballots carry an `["e", pollId]` Nostr tag for relay-side filtering. `AegisTransport.publish` + `subscribe`. |
| **Tally** | `src/lib/quorum/tally.ts` — fetches the drand round signature once the close has passed, unseals every ballot, verifies the embedded Schnorr signature, rejects unsigned / wrong-pollId / not-in-voter-list ballots, counts the survivors. |
| **Open** | Paillier additive-homomorphic tallies (private individual votes, public aggregate) are **deferred** to a future Quorum Pro. Plan §10. |

### Crucible — `/crucible`, `/crucible/newsroom` (`src/lib/crucible/`)

| Aspect | Detail |
|---|---|
| **Routes** | `/crucible` (source dropbox — visible at the same path through Tor Browser), `/crucible/newsroom` (recipient dashboard). |
| **Crypto envelope** | XChaCha20-Poly1305 with AAD `aegis:crucible:v=1`. CEK derived via ECDH(`ephemeralSeckey × newsroomPubkey`) + HKDF-SHA256(x-coord, info=`aegis-crucible-ecdh-v1`, 32). Drop body packed in a self-describing binary layout (`ACV1` magic + text + attachments) — not JSON, so file attachments don't pay base64 overhead. `src/lib/crucible/ecdh.ts` + `envelope.ts`. |
| **Ephemeral identity** | Source mints a one-shot keypair per drop. Seckey wiped (`Uint8Array.fill(0)`) in a `finally` block in `src/lib/crucible/submit.ts`. Aegis master identity never touches the source flow. |
| **Storage** | Source side: ephemeral, in-memory only — no IDB writes. Newsroom side: IndexedDB `aegis-crucible-newsroom` for received drops, decrypt-on-demand. `src/lib/crucible/store.ts`. |
| **Transport surface** | Source publishes an `aegis.crucible.drop` event carrying the ephemeral pubkey + CID. Newsroom subscribes on all three networks. `src/lib/crucible/transport-bridge.ts`. |
| **Tor** | Mandatory part of the deployment topology. `infra/tor/torrc` provisions a `.onion`; sources reach the same `/crucible` route through Tor Browser. Without Tor, the relay / homeserver sees the source's IP. |
| **Pinata** | Same upload path as Beacon — encrypted ciphertext goes to Pinata; the CID is the public anchor. |
| **Open** | Anti-spam (Cloudflare Turnstile is in the network-decisions doc but not yet wired); newsroom multi-recipient (each newsroom currently has one static keypair). |

---

## Build + deploy

### Local dev

```bash
cd aegis
npm install
cp .env.example .env.local            # fill in PINATA_JWT, NEXT_PUBLIC_PINATA_GATEWAY
npm run dev                            # → http://localhost:3000
```

`npm run build` produces the production bundle. Without `PINATA_JWT`, the `/api/pinata/upload-url` route returns 503 and Beacon / Crucible degrade to local-only persistence; the other five features run fine.

### Persistent backend (optional)

`infra/docker-compose.yml` brings up Conduit (Matrix homeserver), strfry (Nostr relay), tor (hidden service), and Caddy (reverse proxy + Let's Encrypt) in one stack.

```bash
cd infra
docker compose up
```

Four services on a shared bridge network (`aegis_net`), with `tor` on host networking so the hidden service reaches Caddy's published 80/443 on 127.0.0.1.

Caddyfile maps:

- `matrix.<domain>` → Conduit (`6167`)
- `relay.<domain>` → strfry (`7777`)

The domain defaults to `aegis.app`; override with `AEGIS_DOMAIN=mydomain.example`. Let's Encrypt email comes from `LETSENCRYPT_EMAIL`.

### Vercel deployment

The Next.js app is Vercel-ready out of the box. The only deployment-time secret required is `PINATA_JWT` (server-side); `NEXT_PUBLIC_PINATA_GATEWAY` is the public IPFS gateway used by the browser.

Vercel Cron is **not** required — Beacon's network-anchored release path uses drand-quicknet timelock instead of a server-side cron, so unattended fires happen without a heartbeat job.

### Environment variables

Documented in `.env.example`:

```
PINATA_JWT                            # server-only Pinata API key
NEXT_PUBLIC_PINATA_GATEWAY            # public IPFS gateway (default: https://gateway.pinata.cloud)
```

Without these, Beacon and Crucible degrade gracefully — the upload endpoint returns 503 and the create flow becomes local-only.

### Security headers

`next.config.ts` applies a baseline to every route:

- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `Referrer-Policy: no-referrer` (magic-link tokens live in URLs — never leak to other origins)
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(self)` — geolocation is required by Atlas; other sensors are denied.

A Content-Security-Policy is deliberately deferred — it requires testing every dynamic-import, every IPFS gateway, every Matrix WASM URL, and is queued for the audit pass.
