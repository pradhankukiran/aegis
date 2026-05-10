/**
 * Aegis Pinata flow — browser-side barrel.
 *
 * Server-only helpers live in `./server` and must NOT be imported from
 * client code (the `import "server-only"` guard inside that module will
 * surface a build error if violated).
 *
 * Beacon (dead-man's broadcast) and Crucible (whistleblower drop) use this
 * module for encrypted-blob persistence that survives device loss and spans
 * newsroom devices.
 */

export {
  PinataNotConfiguredError,
  requestUploadUrl,
  uploadCiphertext,
  uploadEncryptedBlob,
  type SignedUploadUrl,
  type UploadResult,
} from "./upload";

export {
  PinataGatewayNotConfiguredError,
  fallbackGatewayUrls,
  fetchCiphertext,
  gatewayUrl,
} from "./fetch";
