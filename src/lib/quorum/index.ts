/**
 * Quorum — barrel exports for the Phase 5 sealed-ballot voting feature
 * (plan §3.6).
 *
 * Layered surfaces (mirrors Atlas / Herald):
 *   - types         — PollMeta, Ballot, Vote, Tally + event-type constants.
 *   - drand         — round projection helper.
 *   - seal / unseal — timelock-encrypt + signature-verify a ballot.
 *   - poll-store    — IndexedDB CRUD for polls & ballots (browser-only).
 *   - tally         — cross-network + offline tally helpers.
 *   - bridge        — wires `aegis.quorum.poll`/`aegis.quorum.ballot`
 *                     events into the local IDB cache.
 *   - hooks         — React state machinery for the page.
 */

export type {
  Ballot,
  PollMeta,
  Tally,
  Vote,
} from "./types";
export { BALLOT_EVENT_TYPE, POLL_EVENT_TYPE } from "./types";

export { roundForUnixTs } from "./drand";

export {
  decodeSealedToArmored,
  mintVoteNonce,
  SEALED_VERSION,
  sealVote,
  voteDigest,
} from "./seal";

export { unsealVote } from "./unseal";

export {
  clearAll,
  getBallot,
  getPoll,
  loadBallots,
  loadPolls,
  saveBallot,
  savePoll,
} from "./poll-store";

export {
  TALLY_TIMEOUT_MS,
  projectBallotEvent,
  tallyFromBallots,
  tallyPoll,
} from "./tally";

export { attachQuorumBridge, projectPollEvent } from "./transport-bridge";

export {
  isValidPubkeyHex,
  normalizePubkey,
  truncatePubkey,
  useCreatePoll,
  useIdentity,
  usePoll,
  usePolls,
  useQuorumBridge,
  useSubmitBallot,
  useTransport,
} from "./hooks";
export type { CreatePollInput, TransportStatus } from "./hooks";
