# Aegis

> *Your decentralized everything-app — pubkey identity, end-to-end encryption, three independent networks. No single adversary can take you off the air.*

End-to-end encrypted. Censorship-resistant. Federated three ways.
One keypair, one app, **seven** features that share the same identity, transport, and crypto layer.

[![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?style=for-the-badge&logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![React 19](https://img.shields.io/badge/React-19-000000?style=for-the-badge&logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-000000?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tailwind CSS v4](https://img.shields.io/badge/Tailwind-v4-000000?style=for-the-badge&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Vitest](https://img.shields.io/badge/Vitest-363%2F363-000000?style=for-the-badge&logo=vitest&logoColor=white)](https://vitest.dev)

[![Nostr](https://img.shields.io/badge/Nostr-NIP--44%20v2-000000?style=for-the-badge&logoColor=white)](https://github.com/nostr-protocol/nips/blob/master/44.md)
[![Matrix](https://img.shields.io/badge/Matrix-Vodozemac%20WASM-000000?style=for-the-badge&logo=matrix&logoColor=white)](https://matrix.org)
[![Scuttlebutt](https://img.shields.io/badge/Scuttlebutt-ssb--server%20bridge-000000?style=for-the-badge&logoColor=white)](https://scuttlebutt.nz)
[![libsodium](https://img.shields.io/badge/libsodium-XChaCha20--Poly1305-000000?style=for-the-badge&logoColor=white)](https://libsodium.gitbook.io)
[![secp256k1](https://img.shields.io/badge/secp256k1-BIP--340%20Schnorr-000000?style=for-the-badge&logoColor=white)](https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki)
[![drand](https://img.shields.io/badge/drand-quicknet-000000?style=for-the-badge&logoColor=white)](https://drand.love)

<br />

## What it is

A privacy-first super-app. Pubkey identity, end-to-end encrypted, federated three ways for resilience. One keypair generated locally on first run becomes your messenger handle, notes account, location pubkey, voter ID, and whistleblower pseudonym — across every feature.

Aegis publishes through three independent networks simultaneously:

- **Nostr** — permissionless pubkey identity + WebSocket relay broadcast. Instant reach.
- **Matrix** — production-grade E2E (Olm/Megolm over Vodozemac), forward secrecy, group state.
- **Scuttlebutt** — offline-first, append-only, peer-to-peer gossip. Works without infrastructure.

Take down one network and the other two still deliver. Block one country and peers in others still gossip. Same identity, same crypto, three transports.

### Sibling to Hermetic

| | [Hermetic](https://github.com/pradhankukiran/hermetic) | Aegis |
|---|---|---|
| Mode | **Static** seals — encrypt now, unlock later (ten unlock policies) | **Live** transport — real-time messaging, sync, broadcast |
| Storage | IPFS via Pinata (single pinning provider) | Three federated networks (Nostr + Matrix + SSB) |
| Crypto | XChaCha20-Poly1305 envelopes + per-mode wrap policies | Matrix Olm/Megolm group sessions for E2E + per-feature symmetric envelopes |
| Audience | "I want to seal one thing for one purpose" | "I want all my private comms in one censorship-resistant place" |

**Hermetic = a vault. Aegis = a shield.** They cover the two halves of "I want my stuff actually private."

<br />

## The seven features

Each is a real product. They share identity, transport, and crypto.

| Codename | Tagline | Route |
|---|---|---|
| **Herald** | _Real-time E2E chat_ | `/herald` |
| **Scribe** | _Personal + collaborative notes_ | `/scribe` |
| **Atlas** | _Encrypted live location sharing_ | `/atlas` |
| **Witness** | _Multi-network notary_ | `/witness` |
| **Beacon** | _Emergency dead-man's broadcast_ | `/beacon` |
| **Quorum** | _Sealed-ballot voting_ | `/quorum` |
| **Crucible** | _Anonymous whistleblower drop_ | `/crucible` (source) · `/crucible/newsroom` (recipient) |

Long-form per-feature architecture lives in [`docs/architecture.md`](./docs/architecture.md).

<br />

## The three networks

| Network | Library | Brings | Used for |
|---|---|---|---|
| **Nostr** | `nostr-tools` | Permissionless pubkey identity + WebSocket relay broadcast | Public events (notary anchors, polls), Nostr-side DM fallback (NIP-44 v2) |
| **Matrix** | `matrix-js-sdk` + Rust crypto WASM (Vodozemac) | Forward-secret group sessions, post-compromise security, room state | DM primary path, group state, encrypted CRDT updates for shared notes |
| **Scuttlebutt** | `ssb-server` in Docker + thin WebSocket bridge | Offline-first append-only feed | Personal note feed, disaster-mode gossip when other networks are blocked |

Each network is independently verifiable; an attacker would need to compromise all three to deny an event.

<br />

## Stack

| Layer | Tech |
|---|---|
| **Frontend** | Next.js `16.2.6` · React `19.2.4` · Tailwind `v4` · shadcn/ui (`base-nova`) · Lucide |
| **Identity** | Single local secp256k1 keypair (`@noble/curves@2.2.0`), BIP-340 Schnorr signing, IndexedDB persistence |
| **Symmetric** | `libsodium-wrappers@0.8.4` — XChaCha20-Poly1305 with AAD binding per feature (`aegis:<feature>:v=1`) |
| **KDF / hash** | `@noble/hashes@2.2.0` — Argon2id (light/balanced/strong), SHA-256, HKDF-SHA256 |
| **Nostr** | `nostr-tools@2.23.3` — `SimplePool`, NIP-44 v2 DMs (kind 14), NIP-78 (kind 30078) for Aegis events |
| **Matrix** | `matrix-js-sdk@41.4.0` + `@matrix-org/matrix-sdk-crypto-wasm@18.2.0` (Vodozemac), IndexedDB crypto store |
| **Scuttlebutt** | Docker `ssb-server` reached via a thin JSON-over-WebSocket bridge; Ed25519 keys derived via HKDF-SHA256(info=`aegis-ssb-ed25519-v1`) |
| **CRDT** | `yjs@13.6.30` + `y-protocols@1.0.7` for collaborative notes |
| **Map** | `leaflet@1.9.4` + `react-leaflet@5.0.0` over OpenStreetMap raster tiles |
| **Timelock** | `tlock-js@0.9.0` against drand quicknet (used by Quorum sealed ballots + Beacon network-anchored release) |
| **Pinning** | `pinata@2.5.6` — IPFS pin for Beacon ciphertexts and Crucible drops |
| **Tooling** | `vitest@4.1.5` + `happy-dom@20.9.0` · ESLint 9 · TypeScript strict |

Hard pins on every line above match `package.json` exactly. The Vodozemac WASM blob (~1.2 MB raw, ~400-500 kB Brotli) is the largest single asset; it is lazy-loaded on the Herald route.

<br />

## Run locally

```bash
# 1. Install deps
cd aegis && npm install

# 2. Configure environment (see .env.example for full list)
cp .env.example .env.local
# PINATA_JWT — server-only Pinata API key (Beacon + Crucible persistence)
# NEXT_PUBLIC_PINATA_GATEWAY — public IPFS gateway

# 3. Run the app
npm run dev
# → http://localhost:3000
```

Without `PINATA_JWT` the Beacon and Crucible features degrade to local-only persistence; everything else (Herald, Scribe, Atlas, Witness, Quorum) is fully usable against public Nostr relays.

### Optional — local persistent backend

Bring up Conduit (Matrix homeserver), strfry (Nostr relay), ssb-pub (SSB bridge), tor (hidden service), and Caddy (TLS) in one stack:

```bash
cd infra && docker compose up
```

Defaults to `aegis.app` as the served domain; override with `AEGIS_DOMAIN=mydomain.example`. The Caddyfile maps:

- `matrix.<domain>` → Conduit (`6167`)
- `relay.<domain>` → strfry (`7777`)
- `ssb.<domain>` → ssb-pub (`8989`)

Without Docker, Aegis falls back to public Nostr relays and any homeserver / SSB pub the user points it at.

Deploying to Railway instead of a VM? See [`infra/railway/`](./infra/railway/) — three services, no Caddy, no Tor, TLS handled per `*.up.railway.app` URL.

<br />

## Tests

```bash
npx vitest run --no-file-parallelism
```

**363 tests pass across 34 files.** Coverage spans: XChaCha20-Poly1305 round-trip, AAD-binding rejection, Argon2id determinism, SHA-256 vectors, Shamir split/combine, BIP-340 Schnorr verify, per-feature envelope round-trips, cross-network transport dedup, Beacon trigger evaluation, Quorum seal/unseal/tally, Crucible ECDH derivation.

The `--no-file-parallelism` flag is load-bearing: the `kdf.test.ts` Argon2id determinism test occasionally flakes under default parallelism on memory-constrained runners (the `balanced` preset wants 64 MiB per worker). Sequential file execution removes the contention.

Network-touching code (live Nostr relay sockets, live Conduit registration, drand HTTP fetches, Pinata uploads) is tested manually against real services; the unit tests stub at the transport boundary.

<br />

## Threat model summary

- Server operators see ciphertext and minimal metadata. Never plaintext. Never keys.
- Take down one of the three networks and the other two still deliver.
- Same identity is reused across Herald, Scribe, Atlas, Witness, Beacon, Quorum. Crucible sources mint a one-shot ephemeral keypair so source identity never touches IndexedDB.
- We do NOT defend against a compromised browser / device, network metadata, or quantum adversaries against Curve25519 / secp256k1 / drand BLS pairings.
- Lost identity key without a Shamir or recovery-code backup = lost data, by design.

Full document: [`docs/threat-model.md`](./docs/threat-model.md).
Architecture deep dive: [`docs/architecture.md`](./docs/architecture.md).

<br />

## Project layout

```
src/
├── app/
│   ├── api/pinata/upload-url/     server-only Pinata signed-URL endpoint
│   ├── herald/                    real-time chat
│   ├── scribe/                    notes (markdown + Y.js collab)
│   ├── atlas/                     encrypted live location
│   ├── witness/                   multi-network notary + verify
│   ├── beacon/                    dead-man's broadcast
│   ├── quorum/                    sealed-ballot voting
│   └── crucible/                  whistleblower drop (source + newsroom)
├── components/
│   ├── ui/                        shadcn primitives (base-nova)
│   ├── layout/                    page-header, watermark
│   └── <feature>/                 per-feature React components
└── lib/
    ├── identity/                  secp256k1 master keypair + IDB persistence + portable export
    ├── crypto/                    sodium · symmetric · kdf · hash · random · shamir · timelock · schnorr · halo-prf
    ├── transport/                 AegisTransport facade + per-network adapters (nostr · matrix · ssb)
    ├── pinata/                    server client + browser upload helper
    └── <feature>/                 per-feature envelope, store, transport bridge, hooks

infra/
├── docker-compose.yml             conduit + strfry + ssb-pub + tor + caddy
├── Caddyfile                      reverse proxy + Let's Encrypt
├── docker/strfry/                 Nostr relay image
├── docker/ssb-pub/                SSB bridge image (Node.js shim)
└── tor/torrc                      hidden-service config for Crucible
```

<br />

## License

This is a portfolio / personal project. License: **MIT**. See `LICENSE` (TBD).

<br />

<sub>Sibling to [Hermetic](https://github.com/pradhankukiran/hermetic). Vault and shield, two halves of the same posture.</sub>
