/**
 * Aegis identity layer — barrel exports.
 *
 * The master identity is a single secp256k1 keypair, generated locally on
 * first run, persisted in IndexedDB, and exportable as a versioned string.
 * See `keypair.ts` for the full design rationale (Nostr-native master,
 * derivation roadmap for SSB / Matrix).
 */

export {
  PUBKEY_BYTES,
  SECKEY_BYTES,
  generateIdentity,
  pubkeyBase64Url,
  pubkeyHex,
} from "./keypair";
export type { Identity } from "./keypair";

export { clearIdentity, loadIdentity, saveIdentity } from "./storage";

export { exportIdentity, importIdentity } from "./portable";
