/**
 * Unit tests for the worker's Secrets Manager reads.
 *
 * These tests exist because `index.ts` cannot be imported at all — it ends in
 * `main().catch(...)`, so importing it would RUN the worker. Extracting
 * `secrets.ts` is what made any of this testable.
 *
 * **Why not `mockClient(SecretsManagerClient)`, the idiom in
 * lambda/asset-transform/handler.test.ts?** It does not typecheck for this
 * client. `aws-sdk-client-mock@4.1.0` resolves `@smithy/types@4.16.1` while
 * `@aws-sdk/client-secrets-manager@3.1018.0` resolves `@smithy/types@4.13.1`,
 * and two copies of those structural types are not mutually assignable — so
 * `mockClient(SecretsManagerClient)` degrades to `Client<MetadataBearer>` and
 * every `.resolves({ SecretString })` fails `tsc -p worker/tsconfig.json` with
 * TS2353. `handler.test.ts` is clean only because `@aws-sdk/client-s3@3.1092.0`
 * happens to have landed on 4.16.1 too; that is the lockfile's luck, not a
 * property of the idiom. The duplicate is a pre-existing repo condition, filed
 * as .claude/future-tasks/smithy-types-duplicate-resolution.md rather than
 * fixed from a PR about secret handling.
 *
 * So: mock the module boundary instead, and keep the REAL
 * `GetSecretValueCommand` via `importOriginal`. Only the client's `send` is
 * faked. The command this code sends is therefore the genuine SDK command with
 * genuinely serialized input, which is what the SecretId assertion below reads —
 * a hand-rolled command stub could drift from the SDK; this cannot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `vi.mock` factories are hoisted above the imports, so the spy has to be
// created in a `vi.hoisted` block to exist by the time the factory runs.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }))

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-secrets-manager')>()
  return {
    ...actual,
    SecretsManagerClient: class {
      send = sendMock
    },
  }
})

import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'

import { getSecret } from './secrets'

const ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:canopy/github-AbCdEf'

/** The single `GetSecretValueCommand` the call under test sent. */
function sentCommand(index = 0): GetSecretValueCommand {
  return sendMock.mock.calls[index][0] as GetSecretValueCommand
}

beforeEach(() => {
  sendMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/**
 * Drives a call that is expected to schedule retry backoff. Fake timers keep the
 * 1s/2s/4s sleeps off the wall clock; `runAllTimersAsync` also runs timers
 * scheduled by earlier timers, which is what a multi-attempt backoff does.
 */
async function withTimersAdvanced<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers()
  const settled = run().then(
    (value) => () => value,
    (err: unknown) => () => {
      throw err
    },
  )
  await vi.runAllTimersAsync()
  return (await settled)()
}

describe('getSecret', () => {
  it('returns a plain (non-JSON) secret value verbatim', async () => {
    // THE regression guard for every adopter who exists today: a raw PAT is not
    // valid JSON and must come back byte for byte, untouched.
    sendMock.mockResolvedValue({ SecretString: 'ghp_abcdef1234567890' })

    await expect(getSecret(ARN)).resolves.toBe('ghp_abcdef1234567890')
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('sends the ARN as SecretId on a real GetSecretValueCommand', async () => {
    sendMock.mockResolvedValue({ SecretString: 'sk_live_xyz' })

    await expect(getSecret(ARN)).resolves.toBe('sk_live_xyz')
    expect(sentCommand()).toBeInstanceOf(GetSecretValueCommand)
    expect(sentCommand().input).toEqual({ SecretId: ARN })
  })

  it('retries a transient Secrets Manager failure and then succeeds', async () => {
    sendMock
      .mockRejectedValueOnce(new Error('ThrottlingException'))
      .mockResolvedValue({ SecretString: 'ghp_after_retry' })

    const value = await withTimersAdvanced(() => getSecret(ARN))

    expect(value).toBe('ghp_after_retry')
    expect(sendMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after the configured number of retries and rethrows', async () => {
    sendMock.mockRejectedValue(new Error('ThrottlingException'))

    await expect(withTimersAdvanced(() => getSecret(ARN, 3))).rejects.toThrow('ThrottlingException')
    // `retries` counts retries AFTER the first call, so 3 means 4 calls.
    expect(sendMock).toHaveBeenCalledTimes(4)
  })

  it('fails immediately, with no retry, when the secret has no string value', async () => {
    // A binary secret will not become a string on a second read. The call count
    // is the assertion that matters: when this check lived inside the retry
    // `try`, this same input cost 4 calls and 7s of backoff.
    sendMock.mockResolvedValue({ SecretBinary: new Uint8Array([1, 2, 3]) })

    await expect(getSecret(ARN)).rejects.toThrow('has no string value')
    expect(sendMock).toHaveBeenCalledTimes(1)
  })
})
