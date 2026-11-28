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
  depositAddressOf,
  encodeRequestMessage,
  messageIsFor,
  requestHash,
} from './custody/message.js';
export { MAX_SLIPPAGE_BPS, ONE_CLICK_URL, blockchainId, checkRoute } from './custody/route.js';
export type { RouteOptions } from './custody/route.js';
export {
  KEYSTORE_DAO_IDS,
  NEAR_RPC_URLS,
  TEE_KEY_STATEMENT_TAG,
  teeKeyStatement,
  verifyTeeKey,
} from './custody/teeKey.js';
export type { TeeKeyAnswer, TeeKeyExpectation } from './custody/teeKey.js';
export {
  POLICY_STATEMENT_TAG,
  policyStatement,
  verifyPolicyStatement,
} from './custody/policyStatement.js';
export type {
  PolicyStatementAnswer,
  PolicyStatementExpectation,
} from './custody/policyStatement.js';
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
export { AGENT_KEY_SEALED_FORMAT, SetupKey, collectSetup, openSetup } from './custody/setup.js';
export { NEP413_TAG, nep413Hash, verifyNep413 } from './custody/nep413.js';
export type { Nep413Request } from './custody/nep413.js';
export {
  WALLET_CONTRACT_CODE_HASH_HEX,
  deterministicAccount,
  stateBytes,
  stateInitBytes,
} from './custody/deterministic.js';
export type { OpenedSetup, OwnerSignature } from './custody/setup.js';
export { OPERATION_PATH, WalletContract } from './custody/client.js';
export type { OperationState, WalletContractOptions } from './custody/client.js';
