import { Buffer } from "buffer";
import {
  defaultChainInfo,
  mainnetClient,
  roundAt,
  roundTime,
  timelockDecrypt,
  timelockEncrypt,
} from "tlock-js";

/**
 * drand timelock encryption (a.k.a. tlock).
 *
 * tlock-js's `mainnetClient()` is wired to drand quicknet (chain hash
 * 52db9ba70...4e971, 3-second rounds, BLS12-381). That's the network we
 * use everywhere in Aegis.
 *
 * Output of `timelockEncrypt` is an age-armored string. We pass it around
 * as text, including when storing on IPFS (encoded to UTF-8 bytes).
 *
 * Buffer is from the npm `buffer` package (polyfilled by webpack/Next in
 * the browser) so this module works in both Node and the browser.
 */

export const DRAND_CHAIN_HASH = defaultChainInfo.hash;
export const DRAND_PERIOD_SECONDS = defaultChainInfo.period;
export const DRAND_GENESIS_SECONDS = defaultChainInfo.genesis_time;

/** Convert a future Date into the drand round at or after that time. */
export function roundForDate(date: Date): number {
  // roundAt expects milliseconds since epoch.
  return roundAt(date.getTime(), defaultChainInfo);
}

/** Approximate ISO time at which a drand round will be emitted. */
export function dateForRound(round: number): Date {
  // roundTime returns milliseconds.
  return new Date(roundTime(defaultChainInfo, round));
}

/**
 * Encrypt a small payload (typically a 32-byte symmetric key) so it can only
 * be decrypted once drand round `round` has been signed by the network.
 *
 * The payload is wrapped client-side; no network call is needed for encrypt.
 * Decryption fetches the beacon signature for the target round.
 */
export async function timelockEncryptBytes(
  payload: Uint8Array,
  round: number,
): Promise<string> {
  const buf = Buffer.from(payload);
  return timelockEncrypt(round, buf, mainnetClient());
}

export async function timelockDecryptString(
  ciphertext: string,
): Promise<Uint8Array> {
  const result = await timelockDecrypt(ciphertext, mainnetClient());
  return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
}
