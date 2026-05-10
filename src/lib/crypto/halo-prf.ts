/**
 * Halo — WebAuthn PRF extension helpers.
 *
 * The PRF (Pseudo-Random Function) extension lets a Relying Party derive a
 * deterministic 32-byte secret from a passkey-bound HMAC-SHA-256 evaluated
 * over a per-credential salt. Spec: https://w3c.github.io/webauthn/#prf-extension
 *
 *   PRF(credential, salt) -> 32 bytes  (uniform random, HMAC-SHA-256 output)
 *
 * Halo uses this output **directly** as a 32-byte key-encryption key (KEK).
 * The PRF output is uniformly random, so no HKDF / KDF is required.
 *
 * Threat model:
 *  - The 32-byte PRF output **never leaves the authenticator** until a user
 *    gesture authorizes its release. The relying party (Aegis) sees the
 *    output only inside the open tab, only for the duration of the unlock,
 *    and never sends it to a server.
 *  - Without the registered authenticator + the per-halo salt, no one — not
 *    Aegis, not any storage backend, not the network — can recompute the KEK.
 *  - Wrong-device guarantee: an authenticator that did not register this
 *    credential cannot satisfy the assertion (browser refuses to surface
 *    other credentials when `allowCredentials` is set), and even if a
 *    different credential were used the resulting PRF output would not
 *    decrypt the wrapped content key (AEAD tag check fails).
 *
 * Browser support (as of 2025):
 *  - Chrome / Edge / Brave on macOS/Windows/Android: supported via Chrome
 *    Password Manager + platform authenticators.
 *  - Safari 17+ on macOS/iOS 17+: supported on platform authenticators
 *    (iCloud Keychain).
 *  - Firefox: not yet supported on most platforms.
 *  - 1Password / Bitwarden / Dashlane passkeys: supported when version is
 *    recent enough.
 *
 * This file is browser-only (uses navigator.credentials). It MUST NOT be
 * imported from server components.
 */

import { browserSupportsWebAuthn } from "@simplewebauthn/browser";

import { bytesToBase64Url, base64UrlToBytes } from "./encoding";
import { randomBytes } from "./random";

/**
 * Public ID for a registered Halo credential. This is the WebAuthn credential
 * ID (a stable, server-public identifier) encoded as URL-safe base64.
 */
export type HaloCredentialId = string;

export type RegisteredHaloCredential = {
  /** Base64url credential id — safe to embed in the envelope. */
  credentialId: HaloCredentialId;
  /** Base64url 32-byte PRF salt — random, per halo. */
  prfSalt: string;
  /** 32-byte KEK derived from PRF(credential, salt). Wipe after use. */
  kek: Uint8Array;
};

/**
 * The relying-party id (`rp.id`) is bound to the page origin. Browsers refuse
 * registrations whose `rp.id` is not the current origin's eTLD+1. Returning
 * `window.location.hostname` here makes Halo work on localhost, preview
 * deployments, and production without configuration.
 */
function getRpId(): string {
  if (typeof window === "undefined") {
    throw new Error("halo-prf: must be called from the browser");
  }
  return window.location.hostname;
}

/**
 * One-shot WebAuthn-availability gate. Throws a friendly error rather than
 * exposing the underlying NotSupportedError / TypeError from the spec.
 */
function assertWebAuthnAvailable(): void {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    throw new Error(
      "Halo requires a browser environment with WebAuthn support.",
    );
  }
  if (!browserSupportsWebAuthn()) {
    throw new Error(
      "This browser doesn't support WebAuthn. Try Chrome, Edge, Safari 17+, or another modern browser.",
    );
  }
}

/**
 * Type-augmented client-extension results. The standard
 * AuthenticationExtensionsClientOutputs DOM type predates the PRF extension,
 * so we narrow it here without polluting the global scope.
 */
type PrfExtensionOutputs = {
  prf?: {
    enabled?: boolean;
    results?: {
      first?: ArrayBuffer;
      second?: ArrayBuffer;
    };
  };
};

/**
 * Convert an ArrayBuffer-or-Uint8Array PRF output to a 32-byte Uint8Array.
 * Throws if the output is not exactly 32 bytes — that would be a spec
 * violation by the authenticator.
 */
function prfOutputTo32Bytes(buf: ArrayBuffer | Uint8Array): Uint8Array {
  const bytes =
    buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.byteLength !== 32) {
    throw new Error(
      `halo-prf: expected 32-byte PRF output, got ${bytes.byteLength}`,
    );
  }
  // Copy so we own the buffer (the original may live in a credential object).
  return new Uint8Array(bytes);
}

/**
 * Register a new WebAuthn credential and obtain a per-halo PRF KEK.
 *
 * Two-step ceremony:
 *  1. `navigator.credentials.create()` with `prf: {}` to opt the new
 *     credential into PRF support. Some authenticators return the PRF
 *     output here; many do not.
 *  2. Immediately follow with `navigator.credentials.get()` against the
 *     freshly-created credential, with `prf: { eval: { first: salt } }`.
 *     This is the spec-compliant way to obtain a deterministic PRF output
 *     and is what *all* PRF-capable authenticators support.
 *
 * The salt is fresh per halo — even if the user registers the same passkey
 * for two halos, each halo's KEK is independent.
 */
export async function registerHaloCredential(): Promise<RegisteredHaloCredential> {
  assertWebAuthnAvailable();

  const rpId = getRpId();

  // 32-byte challenge — content of the challenge doesn't matter for our
  // zero-knowledge flow (we don't verify attestation), but it must be
  // present and present-as-fresh per the WebAuthn spec.
  const challenge = await randomBytes(32);

  // Per-halo PRF salt. Saved alongside the envelope so the unlock side can
  // reproduce the same KEK when the same credential is asserted.
  const prfSalt = await randomBytes(32);

  // User entity. With no DB and no server, the userHandle is just a random
  // 16-byte value. The `name` / `displayName` show up in the OS passkey UI
  // when the user picks which credential to use.
  const userId = await randomBytes(16);

  const createOptions: CredentialCreationOptions = {
    publicKey: {
      challenge: challenge.buffer.slice(
        challenge.byteOffset,
        challenge.byteOffset + challenge.byteLength,
      ) as ArrayBuffer,
      rp: {
        name: "Aegis",
        id: rpId,
      },
      user: {
        id: userId.buffer.slice(
          userId.byteOffset,
          userId.byteOffset + userId.byteLength,
        ) as ArrayBuffer,
        name: `halo-${bytesToBase64Url(userId).slice(0, 8)}`,
        displayName: "Aegis",
      },
      // ES256 (-7), RS256 (-257), Ed25519 (-8). Standard set; matches what
      // every modern passkey vendor advertises.
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
        { type: "public-key", alg: -8 },
      ],
      authenticatorSelection: {
        // Resident key (a.k.a. discoverable credential) — required so the
        // user can unlock from the URL alone, with no DB-side hint.
        residentKey: "required",
        userVerification: "required",
      },
      timeout: 60_000,
      attestation: "none",
      // PRF extension input. Including `eval.first` here makes some
      // authenticators eagerly produce a PRF output during registration,
      // saving a round trip; we'll fall back to a follow-up assertion if
      // this credential issuer doesn't.
      extensions: {
        prf: {
          eval: {
            first: prfSalt.buffer.slice(
              prfSalt.byteOffset,
              prfSalt.byteOffset + prfSalt.byteLength,
            ) as ArrayBuffer,
          },
        },
        // typed-cast: PRF isn't in the lib.dom AuthenticationExtensionsClientInputs.
      } as AuthenticationExtensionsClientInputs,
    },
  };

  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.create(
      createOptions,
    )) as PublicKeyCredential | null;
  } catch (err) {
    throw mapWebAuthnError(err, "register");
  }
  if (!credential) {
    throw new Error("Halo registration was cancelled");
  }

  const credentialIdBytes = new Uint8Array(credential.rawId);
  const credentialId = bytesToBase64Url(credentialIdBytes);

  // Inspect creation-time extension output. Standards-strict authenticators
  // expose `prf.enabled: true` here (no PRF output during create), while
  // some return `prf.results.first` directly.
  const createExtensions =
    credential.getClientExtensionResults() as AuthenticationExtensionsClientOutputs &
      PrfExtensionOutputs;

  const eagerPrfFirst = createExtensions.prf?.results?.first;
  if (eagerPrfFirst) {
    return {
      credentialId,
      prfSalt: bytesToBase64Url(prfSalt),
      kek: prfOutputTo32Bytes(eagerPrfFirst),
    };
  }

  // If `prf.enabled` is explicitly false, the authenticator does not support
  // PRF on this credential. Surface a helpful error before issuing a second
  // ceremony that we know would fail.
  if (createExtensions.prf?.enabled === false) {
    throw new Error(
      "Your authenticator doesn't support the PRF extension. Try a different passkey provider (Chrome / iCloud Keychain / 1Password) or a hardware key with PRF support.",
    );
  }

  // Follow-up assertion to extract the PRF output. This is the path that
  // most platform authenticators (Touch ID, Windows Hello, Android) take.
  const kek = await assertHaloPrf({
    credentialId,
    salt: bytesToBase64Url(prfSalt),
  });

  return {
    credentialId,
    prfSalt: bytesToBase64Url(prfSalt),
    kek,
  };
}

/**
 * Re-derive the PRF KEK for a previously-registered Halo credential.
 *
 * Used both right after registration (in `registerHaloCredential`) and at
 * unlock time. The browser will only show passkeys whose credentialId is in
 * `allowCredentials`; if no matching passkey is on this device the call
 * fails with NotAllowedError, which we map to a friendly error.
 */
export async function assertHaloPrf({
  credentialId,
  salt,
}: {
  credentialId: HaloCredentialId;
  salt: string;
}): Promise<Uint8Array> {
  assertWebAuthnAvailable();

  const rpId = getRpId();
  const challenge = await randomBytes(32);
  const credentialIdBytes = base64UrlToBytes(credentialId);
  const saltBytes = base64UrlToBytes(salt);
  if (saltBytes.byteLength !== 32) {
    throw new Error(
      `halo-prf: PRF salt must be 32 bytes (got ${saltBytes.byteLength})`,
    );
  }

  const getOptions: CredentialRequestOptions = {
    publicKey: {
      challenge: challenge.buffer.slice(
        challenge.byteOffset,
        challenge.byteOffset + challenge.byteLength,
      ) as ArrayBuffer,
      rpId,
      timeout: 60_000,
      userVerification: "required",
      // Restrict to the credential that sealed this halo. The browser will
      // refuse to surface other credentials, which gives us the wrong-device
      // guarantee for free at the UI level.
      allowCredentials: [
        {
          type: "public-key",
          id: credentialIdBytes.buffer.slice(
            credentialIdBytes.byteOffset,
            credentialIdBytes.byteOffset + credentialIdBytes.byteLength,
          ) as ArrayBuffer,
        },
      ],
      extensions: {
        prf: {
          eval: {
            first: saltBytes.buffer.slice(
              saltBytes.byteOffset,
              saltBytes.byteOffset + saltBytes.byteLength,
            ) as ArrayBuffer,
          },
        },
      } as AuthenticationExtensionsClientInputs,
    },
  };

  let assertion: PublicKeyCredential | null;
  try {
    assertion = (await navigator.credentials.get(
      getOptions,
    )) as PublicKeyCredential | null;
  } catch (err) {
    throw mapWebAuthnError(err, "assert");
  }
  if (!assertion) {
    throw new Error("Halo unlock was cancelled");
  }

  const extensions =
    assertion.getClientExtensionResults() as AuthenticationExtensionsClientOutputs &
      PrfExtensionOutputs;

  const prfFirst = extensions.prf?.results?.first;
  if (!prfFirst) {
    throw new Error(
      "Your authenticator didn't return a PRF output. The credential may not be PRF-capable, or the browser stripped the extension. Try a different passkey or browser.",
    );
  }

  return prfOutputTo32Bytes(prfFirst);
}

/**
 * Map the WebAuthn DOMExceptions into Halo-friendly error messages. The
 * caller can show these directly in the UI; they intentionally do not leak
 * authenticator details.
 */
function mapWebAuthnError(err: unknown, phase: "register" | "assert"): Error {
  // DOMException name dispatch — these are the spec-defined error codes.
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
        return new Error(
          phase === "register"
            ? "Passkey creation was cancelled or timed out."
            : "Passkey approval was cancelled, timed out, or this device doesn't have the matching passkey.",
        );
      case "InvalidStateError":
        return new Error(
          "This authenticator already has a credential for this site.",
        );
      case "NotSupportedError":
        return new Error(
          "Your authenticator doesn't support the requested options (likely PRF or resident keys).",
        );
      case "SecurityError":
        return new Error(
          "WebAuthn refused this request — the page must be served over HTTPS (or localhost) and the rpId must match the page origin.",
        );
      case "AbortError":
        return new Error("Passkey ceremony was aborted.");
      case "ConstraintError":
        return new Error(
          "Your authenticator can't satisfy the requested constraints (try a different passkey).",
        );
      default:
        return new Error(`Passkey ceremony failed: ${err.name}`);
    }
  }
  if (err instanceof Error) return err;
  return new Error("Unknown passkey error");
}
