import _sodium from "libsodium-wrappers";

let readyPromise: Promise<typeof _sodium> | null = null;

/**
 * Returns a libsodium instance once initialization is complete.
 * Safe to call from anywhere — initialization happens at most once.
 */
export function getSodium(): Promise<typeof _sodium> {
  if (!readyPromise) {
    readyPromise = (async () => {
      await _sodium.ready;
      return _sodium;
    })();
  }
  return readyPromise;
}

export type Sodium = typeof _sodium;
