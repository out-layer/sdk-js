import { describe, expect, it } from 'vitest';
import * as custody from '../src/custody.js';
import * as entry from '../src/index.js';
import {
  POLICY_STATEMENT_TAG,
  type PolicyStatementAnswer,
  type PolicyStatementExpectation,
  policyStatement,
  verifyPolicyStatement,
} from '../src/index.js';
import POLICY from './fixtures/custody/policy_statement_vector.json';
import { daoAnswers } from './teeKeyHelpers.js';

// The package is built from `src/index.ts` and exports only "." — what a user
// can import is what this file can import from there.

describe("the package's entry point", () => {
  it('exports everything the custody module exports, as the same values', () => {
    const missing = Object.keys(custody).filter(
      (name) =>
        (entry as Record<string, unknown>)[name] !== (custody as Record<string, unknown>)[name],
    );
    expect(missing).toEqual([]);
  });

  it("holds a policy's ciphertext to the keystore's statement", async () => {
    expect(
      policyStatement(POLICY.dao, POLICY.wallet, POLICY.blob_sha256, POLICY.policy_sha256),
    ).toBe(POLICY.statement);
    expect(POLICY.statement.split('\n')[0]).toBe(POLICY_STATEMENT_TAG);

    const answer: PolicyStatementAnswer = {
      policy_json: POLICY.policy_json,
      keystore_public_key: POLICY.public_key,
      policy_statement_signature: POLICY.signature,
    };
    const expected: PolicyStatementExpectation = {
      walletPubkey: POLICY.wallet,
      encryptedData: POLICY.encrypted_base64,
      keystoreDaoId: POLICY.dao,
      rpcUrl: 'https://rpc.test',
      fetch: (async () => daoAnswers(true)) as unknown as typeof globalThis.fetch,
    };
    expect(await verifyPolicyStatement(answer, expected)).toBe(POLICY.policy_json);
  });
});
