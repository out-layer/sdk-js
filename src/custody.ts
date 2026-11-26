/**
 * Agent On-chain custody: an agent whose main balance lies in a wallet
 * contract on NEAR.
 *
 * The wallet contract executes a request only under two signatures: the
 * agent's and one from OutLayer's enclave. The agent holds its own Ed25519 key
 * and uses it for two things, in two byte formats that cannot stand in for
 * each other:
 *
 * - every HTTPS request to the operation routes is signed with it (there is no
 *   API key on those routes);
 * - its half of each request to the wallet contract.
 *
 * An operation goes one way. The agent asks for it; the enclave judges it by
 * the owner's policy and, if it passes, returns the wallet contract's request
 * with its own half. The agent checks that the request is the operation it
 * asked for, signs its half LAST, and relays. {@link WalletContract.run} does
 * all of it.
 *
 * What is under two signatures is what lies in the wallet contract. The
 * agent's OutLayer wallet (`OutlayerClient`) is a separate account whose key
 * is in the enclave; it pays the gas of relaying and is where the agent keeps
 * what it works with.
 */

export { fromHex, toHex } from './custody/bytes.js';
export { CustodyError } from './custody/errors.js';
export {
  REQUEST_TIMEOUT_SECS,
  encodeRequestMessage,
  messageIsFor,
  requestHash,
} from './custody/message.js';
export type {
  FunctionCallAction,
  Operation,
  RequestMessage,
  TransferAction,
} from './custody/message.js';
export {
  AgentKey,
  agentKeyRequest,
  agentKeySeed,
  agentRequestBytes,
  verifyTeeHalf,
} from './custody/keys.js';
export type { SignedRequestHeaders } from './custody/keys.js';
export { SetupKey, collectSetup, openSetup } from './custody/setup.js';
export type { OpenedSetup } from './custody/setup.js';
export { OPERATION_PATH, WalletContract } from './custody/client.js';
export type { OperationState, WalletContractOptions } from './custody/client.js';
