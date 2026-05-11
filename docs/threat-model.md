# Threat Model

This document describes what Aegis protects against, what it does *not* protect against, and the residual risks. It is written assuming an adversary that is sophisticated, motivated, and has access to plausible levers — subpoenas, server breach, network surveillance, social-engineering of users, hostile relay operators.

If you find a gap not addressed here, please open an issue. We would rather acknowledge a weakness than hide it.

---

## Scope

Aegis is a privacy-first super-app: one local pubkey identity, seven features (Herald, Scribe, Atlas, Witness, Beacon, Quorum, Crucible), two independent transport networks (Nostr, Matrix). Aegis is designed so that:

> **SSB note** — Aegis originally shipped a third network leg (Scuttlebutt
> via a browser-bridge pub). That pub turned out to be unmaintainable in
> production and has been removed. The threat model below has been
> rewritten for the two-network configuration. Offline-mesh resilience
> (the original SSB story) is **not deployed in v1** and is deferred until
> a replacement peer-mesh primitive lands. Sections marked "Adversary H"
> reflect the smaller "one network blocked" scope.

> *Plaintext content and the keys that protect it are never visible to any service operator, any relay, any homeserver, any pin provider, or any combination of them short of compromising the user's own device.*

What follows describes how that property holds, where it stops, and which threats sit outside the scope of a static document like this one (e.g., a compromised endpoint cannot be defeated by cryptography alone).

### Adversary model

| # | Adversary | Capability |
|---|---|---|
| A | Curious operator | Read-only access to a Nostr relay, Matrix homeserver, or the Pinata pinning service |
| B | Malicious operator | Read-write access to one or more of those services |
| C | Network observer | Passive TLS traffic capture, possibly with deep-packet inspection / timing correlation |
| D | Subpoena / court order | Legal compulsion against any single relay, homeserver, pin provider, or hosting platform |
| E | Compromised client | Browser malware, hostile extension, screen-scraping spyware on the *user's* machine |
| F | Lost device / key | The owner's device is lost, stolen, or destroyed with no Shamir / recovery-code backup |
| G | Hostile peer | A trusted-circle member (Atlas), trustee (Beacon recovery), or newsroom recipient (Crucible) turns adversarial |
| H | One of the two networks taken offline | Nostr relays seized or Matrix homeserver blocked |

We assume the cryptographic primitives we use (XChaCha20-Poly1305, Argon2id, secp256k1 BIP-340, Curve25519 Olm/Megolm, BLS12-381 drand timelock, SHA-256) are secure as currently published.

---

## What Aegis protects

Concrete protections, mapped to the code that implements them.

| Threat | Protection | Where it lives |
|---|---|---|
| Curious / malicious relay or homeserver | Every byte of feature content is encrypted client-side. The server sees ciphertext + minimal metadata. | `src/lib/crypto/symmetric.ts` (XChaCha20-Poly1305); per-feature envelopes in `src/lib/<feature>/envelope.ts` |
| Single network blocked or seized | Aegis publishes through Nostr and Matrix simultaneously. Take down one and the other still delivers. | `src/lib/transport/index.ts` (`AegisTransport.publish` runs each network independently via `Promise.allSettled`) |
| Network observer (TLS metadata only) | Content is encrypted before TLS. The wire payload is opaque random-looking bytes. | All `lib/<feature>/envelope.ts` wraps happen before transport hand-off |
| Subpoena against any single vendor | Vendor has only ciphertext + minimal metadata. There is no key, no plaintext to hand over. | Identity material lives in IndexedDB on the user's device only; see `src/lib/identity/storage.ts` |
| Cross-feature envelope substitution | Every feature binds a distinct AAD string (`aegis:notes:v=1`, `aegis:beacon:v=1`, etc). Ciphertext from one feature cannot be decrypted as another. | `SCRIBE_AAD` in `src/lib/scribe/envelope.ts`, `BEACON_AAD` in `src/lib/beacon/envelope.ts`, `CRUCIBLE_AAD` in `src/lib/crucible/envelope.ts` |
| Version-downgrade attack | The envelope `v` field is part of the bound AAD; replaying a future v=2 ciphertext to a v=1 reader fails authentication. | All AAD strings include `:v=1`; bumping a schema requires bumping the AAD |
| Forged beacon cancellation | Cancellations are BIP-340 Schnorr-signed by the beacon owner. Observers verify before honouring. | `src/lib/beacon/cancel.ts` (sign), verified inside `transport-bridge` subscribers |
| Forged ballot under another voter's identity | Each sealed ballot embeds a Schnorr signature over `sha256(canonicalize(vote))` *before* tlock encryption. Tally rejects unsigned / mis-signed entries. | `src/lib/quorum/seal.ts` (sign-then-seal), `src/lib/quorum/tally.ts` (verify after unseal) |
| Notary timestamp denial | The signed `(hash, ts, sig, signer)` tuple is anchored on both networks. An attacker would need to compromise both to deny the timestamp. | `src/lib/witness/anchor.ts` (`publishAnchor` fans out via `AegisTransport.publish`) |
| Pre-close ballot peeking | Each Quorum ballot is timelock-encrypted to the close round via tlock-js. Nobody — not the poll creator, not the relays, not other voters — can decrypt before the drand round arrives. | `src/lib/quorum/seal.ts`, `src/lib/crypto/timelock.ts` |
| Source deanonymization by their own identity | Crucible mints a one-shot ephemeral keypair per drop. The seckey is wiped (`Uint8Array.fill(0)`) in a `finally` block on every code path. Master identity never touches the source flow. | `src/lib/crucible/ephemeral.ts` (`generateEphemeralIdentity` + `wipeEphemeralSeckey`) |
| Replay of a stale Aegis event | Cross-network dedup keyed on `sha256(sender + ":" + type + ":" + canonicalize(content))` over a 60-second TTL window. Same event arriving via both networks fires the subscriber callback once. | `src/lib/transport/index.ts` (`canonicalize`, `aegisEventId`, `DedupCache`) |

---

## What Aegis does NOT protect

| Threat | Why it's out of scope | Where the boundary lives |
|---|---|---|
| Compromised browser / device (Adversary E) | Aegis encrypts in the browser before anything touches the network. If the browser itself is hostile (keylogger, hostile extension, screen recorder), the plaintext is observable *before* encryption. | All `lib/<feature>/hooks.ts` see plaintext at the React state layer |
| Metadata that the networks themselves expose | Aegis publishes through public-by-design networks. Nostr relays log connection IPs; Matrix homeservers log room membership. Some metadata is fundamental to delivery. | `src/lib/transport/nostr.ts`, `matrix.ts` |
| Traffic analysis | An observer watching both networks simultaneously can correlate by timing: an event published "at the same moment" on Nostr and Matrix is plausibly from the same author. We do not jitter publish timing or pad payloads in v1. | `AegisTransport.publish` fans out in parallel without delay |
| Offline-mesh / disaster-mode resilience | **Not protected in v1.** The SSB pub that originally provided this was removed; until a replacement peer-mesh primitive arrives, Aegis assumes online infrastructure (relays, homeservers) is reachable. | n/a — deferred capability |
| Whistleblower deanonymization via fingerprinting | Tor's hidden service hides the source's network location, but browser fingerprinting (canvas, fonts, timezone, screen size) still distinguishes them. We do not ship a Tor Browser bundle; sources should already be on Tor Browser. | `infra/tor/torrc` provisions the onion; the source UI lives at the same `/crucible` route as the regular browser flow |
| Compromise of both networks at once (Adversary H × 2) | The two-network model is robust to ONE adversary blocking ONE network. A coordinated attacker who can blackhole Nostr AND Matrix simultaneously (e.g., a nation-state with both DNS and PKI control) takes down delivery — though stored ciphertexts remain unreadable. | n/a — physical impossibility, not a code path |
| Pre-trigger collusion of Atlas circle members | Circle members can record positions they receive. Aegis cannot enforce "don't keep my position after I share it." | `src/lib/atlas/share-service.ts` — each member receives a per-recipient encrypted DM; what they do with it is outside our reach |
| Hostile newsroom recipient (Crucible) | The newsroom has the static recipient keypair. It can decrypt every drop received. We trust the newsroom — that is the social contract of the feature. | `src/lib/crucible/receive.ts` |
| Quantum adversaries | All current Aegis crypto (secp256k1, Curve25519/Olm/Megolm, BLS12-381 drand pairings) is vulnerable to a large enough quantum computer. Post-quantum migration is research-in-progress upstream. | All identity and ratchet code |
| Lost identity key with no backup (Adversary F) | If the user loses their device and never exported / Shamir-shared their identity, every Aegis feature is permanently locked. There is no escrow. This is by design. | `src/lib/identity/portable.ts` (export only); recovery flows are an open decision — see plan §10 |
| Pinata availability | Beacon ciphertexts and Crucible drops are pinned on IPFS via Pinata. If Pinata removes the pin and no other node has the CID, the encrypted blob is gone. The key + manifest still live on the user's device and on the three transport networks, but the body is unreachable. | `src/lib/pinata/*` |
| Server pretending no event was ever sent | A malicious relay can simply drop messages. The user's `publish` returns failure for that relay; the cross-network design means the message still delivers via the others. But a sufficiently coordinated adversary controlling every relay the user connects to can suppress delivery. | n/a — fundamental to relay-based broadcast |

---

## Per-feature threat surface

Each feature inherits Aegis's identity, transport, and AAD-bound symmetric envelope. The sections below note the *additional* threat surface each feature introduces.

### Herald — real-time E2E chat (`src/lib/herald/`)

- **Adversary model**: curious relay/homeserver, network observer, hostile recipient.
- **DM crypto**: Matrix Olm (1-to-1) and Megolm (groups) via Vodozemac WASM in `matrix-js-sdk@41`. Forward secrecy + post-compromise security. Nostr fallback is NIP-44 v2 (kind 14).
- **Identity surface**: Conversations key on the x-only 64-hex pubkey. The user pastes any 64- or 66-char hex; the bridge normalizes by stripping the parity byte at the input boundary (`src/lib/herald/store.ts` `saveConversation`).
- **Cross-network DM ordering**: Matrix → Nostr fallback chain in `AegisTransport.directMessage`. First to accept wins; the recipient may see the same message twice if a fallback fires after the primary succeeds late — dedup is `sha256(from + ":" + plaintext + ":" + floor(ts/60))` so identical body within the same minute coalesces.
- **Residual risks**: Multi-device cross-signing (SAS, recovery passphrase) is deferred. The Matrix MXID localpart is a one-way 24-hex truncation of the pubkey, so the inbound `from` form is the MXID, not the original pubkey — `IncomingDM.from` callers should treat per-network forms as separate addressing spaces until a directory resolver lands.

### Scribe — notes (`src/lib/scribe/`)

- **Adversary model**: hostile collaborator on a shared note.
- **Crypto**: Two-tier — a Scribe master key derived `HKDF-SHA256(identity.seckey, salt=∅, info="aegis-scribe-notes-v1", 32)`, plus a fresh per-note key. Per-note key is wrapped under the master; content is sealed under the per-note key. Both wrap and content use AAD `aegis:notes:v=1`.
- **What goes on the wire**: nothing in v1. The SSB feed-marker channel that v1's plan documents is now a no-op (SSB removed; see `src/lib/scribe/feed.ts`). Pinata persistence of the encrypted body is the live-infra extension and is the only durable mirror.
- **Collaborative-note crypto**: Y.js CRDT updates are encrypted under a shared per-note key and shipped as `aegis.note.update` custom events through a Matrix room. Not yet wired in v1 — see `src/lib/scribe/crdt.ts` for the local-only Y.Doc plumbing.
- **Residual risks**: deferred Pinata persistence means cross-device note sync depends on identity-import flow + manual seeding. A malicious local-runtime extension can read note content (Adversary E).

### Atlas — encrypted live location (`src/lib/atlas/`)

- **Adversary model**: curious circle member who saved past positions, network observer correlating broadcast cadence.
- **Crypto**: Per-recipient encrypted DM per tick. Tick cadence is 5 minutes by default (`DEFAULT_SHARE_INTERVAL_MS` in `src/lib/atlas/share-service.ts`); the per-tick payload is a JSON `LocationMessage` envelope encrypted under each recipient's pairwise Matrix Olm / Nostr NIP-44 key, fan-out is `Promise.allSettled` so one slow recipient does not block others.
- **What is stored**: circle membership (peer pubkeys + nicknames) in IndexedDB (`src/lib/atlas/circle-store.ts`). Recent positions per peer in a bounded log (`src/lib/atlas/position-store.ts`). No long-term position history server-side.
- **Residual risks**: circle members are *the* threat model. We do not enforce post-receive forgetting. Permission prompts and battery drain are UX issues, not security ones, but a denied geolocation permission surfaces cleanly through `share-service.ts`'s `onError` callback (`GeolocationFetchError`).

### Witness — multi-network notary (`src/lib/witness/`)

- **Adversary model**: an adversary disputing the timestamp on a file.
- **Crypto**: BIP-340 Schnorr signature over `sha256(canonicalize({hash, ts}))` (`src/lib/witness/anchor.ts` `anchorDigest`). Same canonicalizer the transport uses, so verifiers re-derive deterministic bytes. The signed tuple is fanned out via `AegisTransport.publish` as an `aegis.witness` event; each network records its anchor id (Nostr event id, Matrix event id) in the local `AnchorRecord`.
- **Trust model**: An attacker would have to compromise BOTH networks to deny the timestamp. Each network is independently verifiable. A proof viewer (`src/components/witness/ProofViewer.tsx`) walks the record and shows per-network "anchored / failed" badges so the verifier sees the redundancy directly.
- **Residual risks**: An attacker controlling the file's distribution pipe (before hashing) can substitute the document. Witness anchors the hash; it does not vouch for *which* document the hash represents. Hash collision against SHA-256 is presumed infeasible.

### Beacon — dead-man's broadcast (`src/lib/beacon/`)

- **Adversary model**: a watcher who wants to ensure the broadcast fires even if Aegis is closed; an attacker who wants to silence a pending broadcast.
- **Crypto**: XChaCha20-Poly1305 with AAD `aegis:beacon:v=1` (`src/lib/beacon/envelope.ts`). One-tier key model — the unwrap key is stored alongside the beacon row in IndexedDB and ships out in the release event when the watchdog fires.
- **Two-layer trigger**:
  - **Layer A (fast path)** — while Aegis is open in any browser tab, a 60-second `setInterval` (`src/lib/beacon/watchdog.ts`) evaluates `shouldFire(beacon)` and publishes the cleartext `ReleasePayload` on both networks.
  - **Layer B (slow path / unattended)** — at create time, the same release event is wrapped with `tlock-js` against the drand quicknet round at `deadline + grace`, and that timelocked envelope is published to both networks. After the round signs, any subscribing node can decrypt without the user being online. Vercel Cron is not required.
- **Cancellation**: signed `aegis.beacon.cancelled` event (`src/lib/beacon/cancel.ts`). Observers verify the BIP-340 signature before honouring; an unsigned cancel is ignored.
- **Residual risks**:
  - Trustee-quorum trigger (a quorum of trustees forcing the broadcast) is **deferred** — see plan §10 and `src/lib/beacon/types.ts` which leaves the schema room for it.
  - Pinata-blob persistence of the ciphertext is the live-infra layer (`src/lib/beacon/pinata-blob.ts`); if Pinata loses the pin, the timelock release event still carries the key + CID, but observers cannot fetch the body. The release event includes both the CID and the unwrap key, so any IPFS node with the CID can serve it.

### Quorum — sealed-ballot voting (`src/lib/quorum/`)

- **Adversary model**: a poll creator who wants to peek at ballots before close, a voter trying to repudiate or duplicate their own vote, a tallier trying to forge a ballot under someone else's pubkey.
- **Crypto**: Sign-then-seal. Each `Vote` is digested as `sha256(canonicalize({pollId, optionIndex, voter, nonce}))`; the digest is BIP-340 Schnorr-signed; the `{v, vote, sig}` inner payload is JSON-serialized and timelock-encrypted to the poll's `drandRound` via tlock-js. Wire form is base64url of the armored tlock ciphertext.
- **What protects against ballot forgery**: the Schnorr signature is *inside* the timelock envelope. An attacker who watches the wire cannot construct a valid ballot under another voter's pubkey without that voter's seckey. Post-close, the tally verifies the signature *and* rejects ballots whose `voter` is not in `PollMeta.voters` when the poll has a whitelist.
- **What protects against pre-close peeking**: tlock-js cannot be brute-forced without the drand quicknet round signature. Quicknet is a t-of-n threshold network (currently 14/19 nodes); a single drand operator cannot release the round early.
- **Vote replay across polls**: each signed digest includes `pollId`. A ballot lifted from poll A and replayed under poll B has a signature over A's pollId — the tally rejects.
- **Residual risks**:
  - Plain commit-reveal: every ballot's `optionIndex` becomes public post-close. Paillier additive-homomorphic tallies (private individual votes, public final tally) are an open decision (`src/lib/quorum/types.ts` header notes this) — **deferred** to a future Quorum Pro.
  - A voter can submit multiple ballots (re-submission overwrites on `[pollId, voter]`); the IDB store keys on that pair, so the tally counts the latest only.

### Crucible — anonymous whistleblower drop (`src/lib/crucible/`)

- **Adversary model**: a state-level adversary who wants to deanonymize a source; a hostile newsroom that has gone rogue.
- **Crypto**: ECDH(`shared = ephemeralSeckey * newsroomPubkey`) → HKDF-SHA256(x-coord, info=`aegis-crucible-ecdh-v1`, 32) → per-drop CEK. Drop body packed in a self-describing binary layout (magic `ACV1` + text length + text + file count + per-file headers + bytes), sealed under XChaCha20-Poly1305 with AAD `aegis:crucible:v=1`. See `src/lib/crucible/ecdh.ts` and `envelope.ts`.
- **Why ECDH from an ephemeral keypair**: the source never reveals their persistent identity. The wire carries only the ephemeral pubkey; the newsroom derives the same CEK from `newsroomSeckey * ephemeralPubkey`. Ephemeral seckey is wiped in a `finally` block in `src/lib/crucible/submit.ts`.
- **Tor hidden service**: a mandatory part of the deployment topology for the source side. `infra/tor/torrc` provisions a `.onion`; sources reach the same `/crucible` route through Tor Browser. Without Tor, the relay / homeserver sees the source's IP.
- **Residual risks**:
  - Source-side browser fingerprinting (canvas, fonts, timezone, screen size) is not defeated by Tor's network layer alone. Sources should use Tor Browser, which Aegis cannot enforce.
  - Hostile newsroom (Adversary G): the newsroom has the static recipient seckey. It can decrypt every drop received. That trust relationship is the feature, not a bug.
  - Plaintext compression before encryption is deliberately skipped (size side-channels). Large file uploads are bounded by Pinata's free-tier cap, not by the envelope.

---

## Cryptographic primitives

Every primitive Aegis uses, why it was chosen, and the known caveats.

| Primitive | Where | Why | Caveats |
|---|---|---|---|
| **XChaCha20-Poly1305** | `src/lib/crypto/symmetric.ts` — every per-feature envelope | 24-byte nonce → random nonces are safe (birthday-bound ~2^-96 over 2^48 messages). AEAD with optional AAD. Constant-time in the libsodium implementation. | Confidentiality + integrity, but no forward secrecy at the symmetric layer. That property comes from session-level key rotation in Matrix Megolm / Olm. |
| **Argon2id** | `src/lib/crypto/kdf.ts` — three presets (light t=2/m=19MiB, balanced t=3/m=64MiB, strong t=4/m=128MiB) | Memory-hard, side-channel-resistant (i + d hybrid), RFC 9106. Async variant used so the main thread isn't blocked. | Currently unused in v1 features — reserved for the open identity-recovery decision (`light` is documented as recovery-code-only; pair with a high-entropy input or use `balanced`). |
| **SHA-256** | `src/lib/crypto/hash.ts`; `transport/index.ts`'s `aegisEventId`; Witness's `anchorDigest`; Quorum's `voteDigest` | Standard, fast, universally implemented. Used as a domain-separated hash for digests that BIP-340 signs over. | Collision resistance ~2^128. No post-quantum guarantees against Grover speedup (still 2^128 quantum cost — practically irrelevant). |
| **HKDF-SHA256** | Scribe master (`aegis-scribe-notes-v1`); Crucible CEK (`aegis-crucible-ecdh-v1`) | RFC 5869, extracts a uniform PRK from non-uniform IKM (raw ECDH x-coord), then expands to a domain-separated application key. | Salt is empty across all callers (zero block per RFC). The `info` strings are the domain-separation tag — changing them is a wire-breaking change. |
| **secp256k1 BIP-340 Schnorr** | Identity signing in `src/lib/identity/` and every feature that needs an authenticated signature; `@noble/curves/secp256k1.js#schnorr` | Same curve as Bitcoin / Nostr — interoperable with the Nostr ecosystem out of the box. BIP-340 fixes malleability, x-only pubkeys (32 bytes), batch-verifiable. | Curve over a 256-bit prime → 128-bit classical security. **NOT post-quantum.** A sufficiently powerful quantum adversary running Shor's algorithm breaks it. |
| **secp256k1 ECDH** | Crucible source/newsroom pairwise CEK derivation; `src/lib/crucible/ecdh.ts` | Same curve as identity; uses the existing keypair instead of introducing X25519. Output is HKDF-expanded so non-uniform x-coords don't bias the CEK. | Same quantum caveat as Schnorr. |
| **Olm / Megolm (via Vodozemac WASM)** | Matrix DMs (Olm) + group rooms (Megolm); `@matrix-org/matrix-sdk-crypto-wasm@18.2.0` | Forward secrecy + post-compromise security; battle-tested across Element Web, mobile, every Matrix SDK. Vodozemac is a pure-Rust reimplementation of Olm/Megolm, publicly audited. | Curve25519 underneath → same quantum caveat. WASM blob (~1.2 MB raw, ~400-500 kB Brotli) is the largest single asset in Aegis. |
| **NIP-44 v2 (ChaCha20 + HMAC-SHA256)** | Nostr DMs (`src/lib/transport/nostr.ts`); fallback for `directMessage` | The current Nostr DM standard, supersedes NIP-04. Authenticated encryption with versioned framing. | Not forward-secure (long-term identity key directly encrypts). Compromise of either party's seckey unlocks the entire DM history. We use it only as Matrix's fallback; the primary DM path is Matrix Olm. |
| **tlock-js (drand quicknet timelock)** | Quorum sealed ballots; Beacon network-anchored release; `src/lib/crypto/timelock.ts` | Threshold time-lock encryption; no party can decrypt before the target drand round signs (~3s rounds on quicknet). Quicknet is a t-of-n network (currently 14/19 nodes) — a single operator cannot release early. | BLS12-381 pairings → known vulnerable to a sufficiently powerful quantum adversary. Plan around this for long-horizon timelocks. |
| **Shamir's Secret Sharing (GF(256))** | `src/lib/crypto/shamir.ts` (ported from Hermetic) | Information-theoretically secure secret splitting — a single share carries zero information about the secret. | Not yet used by any v1 Aegis feature. Reserved for the open identity-recovery decision (trustee-shared identity backup). |
| **WebAuthn PRF (Halo)** | `src/lib/crypto/halo-prf.ts` (ported, optional) | Hardware-bound KEK; the authenticator never exports it. | Not yet wired into any Aegis flow. Reserved for the open identity-recovery decision (passkey-bound recovery). Requires a PRF-capable authenticator. |

---

## Key management

Aegis runs on a single secp256k1 master keypair generated locally on first run (`src/lib/identity/keypair.ts` → IndexedDB `aegis` / `identity` store, primary key `"primary"`).

Per-network derivations:

| Target | Derivation | Where |
|---|---|---|
| Nostr pubkey | Strip the SEC1 parity byte; emit the x-only 32-byte form (BIP-340) | `src/lib/transport/nostr.ts` (`NostrTransport` constructor) |
| Matrix MXID | `@<first 24 hex chars of identity.pubkey x-coord>:<homeserver-domain>` | `src/lib/transport/matrix.ts` (`deriveLocalpart`) |

Per-feature symmetric key derivations:

| Feature | Derivation | Where |
|---|---|---|
| Scribe master | `HKDF-SHA256(identity.seckey, salt=∅, info="aegis-scribe-notes-v1", 32)`. Per-note keys are minted fresh and wrapped under this master. | `src/lib/scribe/envelope.ts` (`deriveMasterKey`) |
| Beacon | Per-beacon symmetric key, generated fresh, stored locally alongside the row. No master-derived wrap. | `src/lib/beacon/envelope.ts` (`encryptPayload`) |
| Crucible (source) | Ephemeral keypair per drop. ECDH against newsroom pubkey → HKDF(info=`aegis-crucible-ecdh-v1`). Seckey wiped in `finally`. | `src/lib/crucible/ephemeral.ts` + `ecdh.ts` |
| Crucible (newsroom) | Static newsroom keypair (configured by the recipient). Same HKDF derivation produces the matching CEK. | `src/lib/crucible/receive.ts` |
| Quorum | No symmetric key — each ballot is timelock-encrypted under tlock-js to the poll's drand round. | `src/lib/quorum/seal.ts` |

Per-feature AAD strings (the version-bound integrity tag for every envelope):

```
aegis:notes:v=1        (Scribe)
aegis:beacon:v=1       (Beacon)
aegis:crucible:v=1     (Crucible)
aegis:atlas:v=1        (Atlas — reserved; v1 uses transport-level Matrix Olm / NIP-44 DM crypto)
aegis:herald:olm:v=1   (Herald — reserved; v1 uses transport-level Matrix Olm + NIP-44 v2 framing)
```

Bumping a feature schema requires bumping the AAD `v=` field. A v=2 envelope cannot be silently downgraded into a v=1 reader's parse path.

### Identity recovery

**Not yet implemented.** Plan §10 left this open. Two candidate flows:

1. **Shamir-shared identity backup** — split `identity.seckey` K-of-N via the existing `src/lib/crypto/shamir.ts` and distribute shares to trustees (mirrors Hermetic's Switch pattern).
2. **One-time printable recovery passphrase** — derive a backup key via Argon2id over a 24-word BIP-39-style mnemonic; store nothing server-side.

Until one ships, **lost master key with no manual export = unrecoverable data**. The export flow (`src/lib/identity/portable.ts` `exportIdentity`) emits a versioned `aegis:id:v=1:<base64url>` blob; users are responsible for storing it safely.

---

## Audit notes

What an external review should focus on. This is the checklist the maintainer would hand a reviewer.

- **AAD coverage.** Every per-feature envelope binds an AAD that includes the feature name and version. Verify that the AAD is supplied on both encrypt and decrypt for every code path. Files: `src/lib/scribe/envelope.ts`, `src/lib/beacon/envelope.ts`, `src/lib/crucible/envelope.ts`.
- **Key derivation correctness.** HKDF info strings (`aegis-scribe-notes-v1`, `aegis-crucible-ecdh-v1`) are documented as wire-breaking changes if modified. Verify call sites pass the right info string and length. Files: `src/lib/scribe/envelope.ts`, `src/lib/crucible/ecdh.ts`.
- **Dedup window correctness.** Cross-network dedup keys on `sha256(sender + ":" + type + ":" + canonicalize(content))` with a 60-second TTL. Verify the canonicalizer matches across publish and subscribe (same module). Verify the TTL does not allow legitimate retries to collide. File: `src/lib/transport/index.ts` (`canonicalize`, `aegisEventId`, `DedupCache`).
- **Sign-then-seal on Quorum ballots.** Signatures are inside the timelocked envelope. Verify the digest covers `pollId, optionIndex, voter, nonce` and that the tally verifies both the signature AND voter-list membership before counting. Files: `src/lib/quorum/seal.ts`, `src/lib/quorum/tally.ts`.
- **Schnorr signature on Beacon cancellations.** Verify the bridge subscriber refuses unsigned cancels and refuses cancels signed by someone other than the beacon's authoring pubkey. Files: `src/lib/beacon/cancel.ts`, `src/lib/beacon/transport-bridge.ts`.
- **Replay attack surface.** Witness anchors include `ts` in the digest; Quorum ballots include `nonce` and `pollId`; Beacon releases include `beaconId` and `firedAt`. Verify every wire field that an attacker could re-broadcast is bound into a signature or is irrelevant to integrity.
- **IndexedDB isolation between origins.** Aegis writes to `aegis`, `aegis-herald`, `aegis-scribe`, `aegis-atlas`, `aegis-beacon`, `aegis-crucible-newsroom`, `aegis-quorum`, `aegis-witness`. The browser enforces same-origin isolation for IDB. A user visiting two Aegis deployments under different hostnames has independent identity material per hostname — this is correct, but should be documented to users.
- **Ephemeral seckey wipe (Crucible).** Verify `wipeEphemeralSeckey` runs in a `finally` block on every code path that touches the ephemeral key. File: `src/lib/crucible/submit.ts`.
- **AAD on the wire never includes user-controlled strings.** All AAD strings are compile-time constants (`SCRIBE_AAD`, `BEACON_AAD`, `CRUCIBLE_AAD`). Verify no caller passes a user-supplied AAD into `encryptBytes` / `decryptBytes`.
- **Library pins.** Verify `package.json` pins exactly the versions documented in `aegis-networks-decisions.md` (`matrix-js-sdk@41.4.0`, `nostr-tools@2.23.3`, `tlock-js@0.9.0`, etc). Upstream bumps in `matrix-js-sdk` past 41.x may remove `initLegacyCrypto` and require code changes.

---

## Reporting

Security-relevant issues should be reported privately. For ordinary bugs, please open a GitHub issue. A public security policy file will land before the public launch.
