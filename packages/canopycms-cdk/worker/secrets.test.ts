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

/**
 * `workerLogWarn` is `console.warn` plus an ISO-8601 prefix and a `WARN` tag, so
 * spying on `console.warn` is how the warning is observed. eslint's worker
 * console ban is a `MemberExpression[object.name='console']` selector, which
 * `vi.spyOn(console, 'warn')` is not — deliberately, per its comment.
 */
let warnSpy: ReturnType<typeof vi.spyOn>

/** Every warning emitted, flattened — `workerLogWarn` passes the timestamp, the level and the message as separate console arguments. */
function warnText(): string {
  return warnSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n')
}

beforeEach(() => {
  sendMock.mockReset()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
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

    await expect(withTimersAdvanced(() => getSecret(ARN, { retries: 3 }))).rejects.toThrow(
      'ThrottlingException',
    )
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

/**
 * One `describe` per column of the decision table in the PR: what happens with
 * `jsonField` absent, and what happens with it set. The two halves are
 * deliberately exhaustive over the value shapes JSON can take, because the
 * absent half is a compatibility promise and the set half is a diagnostics
 * promise, and both are easy to erode by accident.
 */
describe('getSecret with no jsonField configured', () => {
  const DOCUMENT = JSON.stringify({
    CLERK_SECRET_KEY: 'sk_live_xyz',
    CLERK_JWT_KEY: 'jwt',
    GITHUB_TOKEN: 'ghp_1',
  })

  it.each([
    ['a GitHub PAT', 'ghp_abcdef1234567890'],
    ['a GitHub App installation token', 'ghs_abcdef1234567890'],
    ['a Clerk secret key', 'sk_live_ZXhhbXBsZQ'],
    ['a value with JSON-ish punctuation', 'not{json}at:all'],
    ['a value with leading whitespace', '  ghp_padded  '],
  ])('returns %s verbatim', async (_label, raw) => {
    sendMock.mockResolvedValue({ SecretString: raw })

    await expect(getSecret(ARN)).resolves.toBe(raw)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['a JSON number', '42'],
    ['a JSON string', '"a string"'],
    ['JSON null', 'null'],
    ['a JSON array', '["a","b"]'],
  ])(
    'returns %s verbatim and does NOT warn — a scalar is not a credential document',
    async (_label, raw) => {
      sendMock.mockResolvedValue({ SecretString: raw })

      await expect(getSecret(ARN)).resolves.toBe(raw)
      expect(warnSpy).not.toHaveBeenCalled()
    },
  )

  it('returns a JSON OBJECT verbatim — behaviour is unchanged even here', async () => {
    // The warning is a warning, not a behaviour change: a deployment that is
    // somehow relying on the whole document keeps working.
    sendMock.mockResolvedValue({ SecretString: DOCUMENT })

    await expect(getSecret(ARN)).resolves.toBe(DOCUMENT)
  })

  it('warns loudly on a JSON object, naming the keys and the env var to set', async () => {
    // The point of request #46: the old failure was SILENT. Nothing errored
    // until Clerk rejected the key, a long way from the cause.
    sendMock.mockResolvedValue({ SecretString: DOCUMENT })

    await getSecret(ARN, { jsonFieldEnvVar: 'CLERK_SECRET_KEY_SECRET_JSON_FIELD' })

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const warning = warnText()
    expect(warning).toContain(ARN)
    expect(warning).toContain('"CLERK_SECRET_KEY"')
    expect(warning).toContain('"CLERK_JWT_KEY"')
    expect(warning).toContain('CLERK_SECRET_KEY_SECRET_JSON_FIELD')
  })

  it('never puts a secret VALUE in the warning', async () => {
    sendMock.mockResolvedValue({ SecretString: DOCUMENT })

    await getSecret(ARN, { jsonFieldEnvVar: 'CLERK_SECRET_KEY_SECRET_JSON_FIELD' })

    // Paired with the positive assertions above so this cannot pass by the
    // warning being absent: worker.log is shipped to CloudWatch, and `task.error`
    // reaches the admin panel's browser.
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnText()).not.toContain('sk_live_xyz')
    expect(warnText()).not.toContain('ghp_1')
  })

  it('still warns when no env var name was supplied, without printing "undefined"', async () => {
    sendMock.mockResolvedValue({ SecretString: DOCUMENT })

    await getSecret(ARN)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnText()).toContain('Configure the JSON field')
    expect(warnText()).not.toContain('undefined')
  })

  it('treats an empty jsonField as not configured — a blank env var is not a field name', async () => {
    sendMock.mockResolvedValue({ SecretString: 'ghp_abcdef1234567890' })

    await expect(getSecret(ARN, { jsonField: '' })).resolves.toBe('ghp_abcdef1234567890')
  })
})

describe('getSecret with a jsonField configured', () => {
  it('returns the named field of a JSON document', async () => {
    sendMock.mockResolvedValue({
      SecretString: JSON.stringify({ CLERK_SECRET_KEY: 'sk_live_xyz', CLERK_JWT_KEY: 'jwt' }),
    })

    await expect(getSecret(ARN, { jsonField: 'CLERK_SECRET_KEY' })).resolves.toBe('sk_live_xyz')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('throws when the field is missing, naming the field and the keys present', async () => {
    sendMock.mockResolvedValue({
      SecretString: JSON.stringify({ CLERK_SECRET_KEY: 'sk_live_xyz', CLERK_JWT_KEY: 'jwt' }),
    })

    // A typo'd field name is the likeliest failure here, so the message has to
    // carry enough to fix it without a second deploy.
    const err = await getSecret(ARN, { jsonField: 'CLERK_SECRET' }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).toContain(ARN)
    expect(message).toContain('"CLERK_SECRET"')
    expect(message).toContain('"CLERK_SECRET_KEY"')
    expect(message).toContain('"CLERK_JWT_KEY"')
    expect(message).not.toContain('sk_live_xyz')
  })

  it('names "(none)" rather than an empty list for an empty JSON object', async () => {
    sendMock.mockResolvedValue({ SecretString: '{}' })

    await expect(getSecret(ARN, { jsonField: 'CLERK_SECRET_KEY' })).rejects.toThrow(
      'Keys present: (none).',
    )
  })

  it('throws, once and with no retry backoff, on malformed JSON', async () => {
    // Pins the commit-1 restructure from the other end: a parse failure is
    // deterministic, so re-fetching cannot help. Inside the retry loop this
    // would be 4 calls and 7s of backoff, reported as "attempt 4".
    sendMock.mockResolvedValue({ SecretString: '{"CLERK_SECRET_KEY": "sk_live' })

    await expect(getSecret(ARN, { jsonField: 'CLERK_SECRET_KEY' })).rejects.toThrow(
      'is not valid JSON',
    )
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it('throws, once, on a plain non-JSON credential', async () => {
    // The configuration error this catches: an ARN pointed at a raw PAT while a
    // field name is set. Silently returning the PAT would "work", then break the
    // day the secret is converted to a document.
    sendMock.mockResolvedValue({ SecretString: 'ghp_abcdef1234567890' })

    const err = await getSecret(ARN, { jsonField: 'GITHUB_TOKEN' }).catch((e: unknown) => e)

    expect((err as Error).message).toContain('is not valid JSON')
    expect((err as Error).message).not.toContain('ghp_abcdef1234567890')
    expect(sendMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a JSON number', '42', 'a number'],
    ['a JSON string', '"a string"', 'a string'],
    ['JSON null', 'null', 'null'],
    ['a JSON array', '["a","b"]', 'an array'],
  ])('throws on %s, saying what it actually got', async (_label, raw, described) => {
    sendMock.mockResolvedValue({ SecretString: raw })

    await expect(getSecret(ARN, { jsonField: 'CLERK_SECRET_KEY' })).rejects.toThrow(
      `its value is ${described}, not a JSON object`,
    )
  })

  it.each([
    ['a number', JSON.stringify({ PORT: 8080 }), 'PORT', 'a number'],
    ['null', JSON.stringify({ CLERK_SECRET_KEY: null }), 'CLERK_SECRET_KEY', 'null'],
    ['an object', JSON.stringify({ nested: { k: 'v' } }), 'nested', 'an object'],
    ['an array', JSON.stringify({ list: ['a'] }), 'list', 'an array'],
  ])('throws when the field is present but is %s', async (_label, raw, field, described) => {
    sendMock.mockResolvedValue({ SecretString: raw })

    await expect(getSecret(ARN, { jsonField: field })).rejects.toThrow(
      `is ${described}, not a string`,
    )
  })

  it('does not read inherited properties — "constructor" is not a field', async () => {
    // `doc[field] !== undefined` would return `Object`'s constructor here, which
    // then fails the string check with a message about a "function" that is
    // nowhere in the adopter's document.
    sendMock.mockResolvedValue({ SecretString: JSON.stringify({ CLERK_SECRET_KEY: 'sk_live' }) })

    await expect(getSecret(ARN, { jsonField: 'constructor' })).rejects.toThrow(
      'has no field "constructor"',
    )
  })

  it('reads a field literally named __proto__ as an ordinary key', async () => {
    // JSON.parse defines `__proto__` as an own data property rather than
    // invoking the setter, so this is a real field and not prototype pollution.
    sendMock.mockResolvedValue({ SecretString: '{"__proto__":"ghp_weird"}' })

    await expect(getSecret(ARN, { jsonField: '__proto__' })).resolves.toBe('ghp_weird')
  })

  it('returns an empty-string field verbatim rather than treating it as missing', async () => {
    sendMock.mockResolvedValue({ SecretString: JSON.stringify({ CLERK_SECRET_KEY: '' }) })

    await expect(getSecret(ARN, { jsonField: 'CLERK_SECRET_KEY' })).resolves.toBe('')
  })

  it('still retries a transient transport failure before parsing', async () => {
    sendMock
      .mockRejectedValueOnce(new Error('ThrottlingException'))
      .mockResolvedValue({ SecretString: JSON.stringify({ CLERK_SECRET_KEY: 'sk_live_xyz' }) })

    const value = await withTimersAdvanced(() => getSecret(ARN, { jsonField: 'CLERK_SECRET_KEY' }))

    expect(value).toBe('sk_live_xyz')
    expect(sendMock).toHaveBeenCalledTimes(2)
  })
})
