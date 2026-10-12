import { generateKeyPairSync, randomBytes } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mockConsole, octokitErrorFor, type MockConsole } from '../test-utils'
import { escapeForLog } from '../utils/escape-text'
import {
  gatewayLog,
  gatewayLogWarn,
  redactEgress,
  redactError,
  redactValue,
  registerLiveSecret,
  registerPrivateKey,
  registerSecretText,
} from './gateway-egress'

/**
 * No GitHub prefix, so only the exact-string scrub can catch it; `~` puts a `+` in its base64, so
 * the URL-encoded form differs.
 */
const TOKEN = 'CANARY~~~egress0123456789abcdefABCDEF'
const pair = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')
const FORMS = [TOKEN, pair, `AUTHORIZATION: basic ${pair}`, encodeURIComponent(pair)]
/** The secret-bearing part of each form; the base64 pair's first 20 characters never vary. */
const SECRETS = [TOKEN, pair.slice(20), encodeURIComponent(pair).slice(20)]

let consoleSpy: MockConsole

beforeEach(() => {
  consoleSpy = mockConsole()
  registerLiveSecret(TOKEN)
})

afterEach(() => {
  consoleSpy.restore()
})

/** No 16 characters in a row of any form: a partial scrub leaks too. */
const holdsNoForm = (text: string) => {
  for (const secret of SECRETS) {
    for (let i = 0; i + 16 <= secret.length; i++)
      expect(text).not.toContain(secret.slice(i, i + 16))
  }
}

describe('redactEgress', () => {
  it('scrubs every form a registered token takes', () => {
    expect(encodeURIComponent(pair)).not.toBe(pair)
    for (const form of FORMS) {
      const scrubbed = redactEgress(`before ${form} after`)
      holdsNoForm(scrubbed)
      expect(scrubbed).toMatch(/^before .* after$/)
    }
  })

  it('leaves a short value alone rather than scrub ordinary text', () => {
    registerLiveSecret('main')
    expect(redactEgress('pushed main')).toBe('pushed main')
  })

  it('still applies redactCredentials, for a token never registered', () => {
    expect(redactEgress('https://x:ghp_unregistered12345@github.com')).not.toContain(
      'ghp_unregistered12345',
    )
  })
})

describe('redactError', () => {
  it('scrubs an Octokit error in place: message, stack, response and request, and its cause', async () => {
    const error = await octokitErrorFor(401, { message: `Bad credentials ${TOKEN}`, token: pair })
    Object.assign(error, { cause: new Error(`caused by ${TOKEN}`) })
    const status = (error as Error & { status: number }).status

    const scrubbed = redactError(error)

    expect(scrubbed).toBe(error)
    expect((error as Error & { status: number }).status).toBe(401)
    expect(status).toBe(401)
    holdsNoForm(JSON.stringify(error, Object.getOwnPropertyNames(error)))
    // A key list filters nested keys too, so the nested parts are checked whole.
    const nested = error as Error & { response: unknown; request: unknown }
    holdsNoForm(JSON.stringify([nested.response, nested.request]))
    holdsNoForm(String(error.stack))
    holdsNoForm(String((error as Error & { cause: Error }).cause.message))
  })

  it('leaves an error with nothing to scrub untouched, a DOMException included', () => {
    const aborted = new DOMException('This operation was aborted', 'AbortError')
    expect(redactError(aborted)).toBe(aborted)
  })

  it('replaces an error whose message cannot be set', () => {
    const frozen = Object.freeze(new Error(`frozen ${TOKEN}`))

    const scrubbed = redactError(frozen)

    expect(scrubbed).toBeInstanceOf(Error)
    expect(scrubbed).not.toBe(frozen)
    holdsNoForm((scrubbed as Error).message)
  })

  it('scrubs a thrown string', () => {
    holdsNoForm(String(redactError(`thrown ${TOKEN}`)))
  })
})

describe('redactValue', () => {
  it("scrubs strings at any depth, a Map's keys included, and returns the same object when clean", () => {
    const clean = { a: ['x', { b: 'y' }], m: new Map([['k', 'v']]) }
    expect(redactValue(clean)).toBe(clean)

    const dirty = { a: ['x', { b: TOKEN }], m: new Map([[TOKEN, pair]]), n: 1 }
    const scrubbed = redactValue(dirty)
    holdsNoForm(JSON.stringify({ ...scrubbed, m: [...scrubbed.m] }))
    expect(scrubbed.n).toBe(1)
    expect(dirty.a[1]).toEqual({ b: TOKEN })
  })
})

describe('redactValue, for answers', () => {
  it('scrubs live tokens only, never by pattern: a branch named like a token is data', () => {
    const names = [
      'chore/github_pat_rotation',
      'ghs_cleanup_scripts',
      'eyJ-review-notes.abcdefghij.x',
    ]
    const refs = new Map(names.map((name) => [name, 'a'.repeat(40)]))

    expect(redactValue(refs)).toBe(refs)
    for (const name of names) expect(redactEgress(name)).not.toBe(name)
  })
})

describe('the gateway log', () => {
  it('escapes every non-printable character, so a field cannot forge or reorder a line', () => {
    expect(escapeForLog('a\nb\tc\rd')).toBe('a\\nb\\tc\\rd')
    expect(escapeForLog('ma\u202ein\u200b')).toBe('ma\\u{202e}in\\u{200b}')
    expect(escapeForLog('caf\u00e9 \u0007')).toBe('caf\\xe9 \\x07')
    // A literal backslash-n in the input cannot pass for an escaped newline.
    expect(escapeForLog('x\\ny')).toBe('x\\\\ny')
  })

  it('writes one scrubbed, escaped line', () => {
    gatewayLogWarn(`branch evil\n2026-01-01T00:00:00.000Z INFO forged`, new Error(`git: ${TOKEN}`))

    const [line] = consoleSpy.all().warn
    expect(line).not.toContain('\n')
    expect(line).toContain('evil\\n2026')
    holdsNoForm(line)
  })
})

/** The auth provider's key: alphanumeric, so URL-encoding leaves it as it is. */
const CLERK_KEY = `sk_live_${randomBytes(20).toString('hex')}`

describe('registerSecretText', () => {
  beforeEach(() => {
    registerSecretText(CLERK_KEY)
  })

  it('scrubs the key from an egress message, raw and URL-encoded', () => {
    expect(redactEgress(`provider said ${CLERK_KEY}`)).not.toContain(CLERK_KEY)
    expect(redactEgress(`GET /?key=${encodeURIComponent(CLERK_KEY)}`)).not.toContain(CLERK_KEY)
  })

  it('scrubs the URL-encoded form of a value that encodes differently', () => {
    const odd = 'sk/live+odd value=0123456789'
    registerSecretText(odd)

    const scrubbed = redactEgress(`raw ${odd} encoded ${encodeURIComponent(odd)}`)

    expect(scrubbed).not.toContain('odd value')
    expect(scrubbed).not.toContain(encodeURIComponent(odd))
    expect(scrubbed).not.toContain('odd%20value')
  })

  it('scrubs the key from an answer', () => {
    const answer = { users: [{ id: 'u', name: `name ${CLERK_KEY}` }], note: [CLERK_KEY] }

    expect(JSON.stringify(redactValue(answer))).not.toContain(CLERK_KEY)
  })

  it('scrubs the key from an error: message and stderr', () => {
    const error = Object.assign(new Error(`failed with ${CLERK_KEY}`), {
      stderr: `stderr ${CLERK_KEY}`,
    })

    const scrubbed = redactError(error) as Error & { stderr: string }

    expect(scrubbed.message).not.toContain(CLERK_KEY)
    expect(scrubbed.stderr).not.toContain(CLERK_KEY)
  })

  it('scrubs the key from a log line', () => {
    gatewayLog(`refreshing with ${CLERK_KEY}`)

    const [line] = consoleSpy.all().log
    expect(line).toBeDefined()
    expect(line).not.toContain(CLERK_KEY)
  })

  it('leaves a short value alone', () => {
    registerSecretText('short')
    expect(redactEgress('a short text')).toBe('a short text')
  })

  it('stops scrubbing a key the cap has dropped, as it does a token', () => {
    for (let i = 0; i < 40; i++)
      registerLiveSecret(`CANARY-cap-${i}-${randomBytes(8).toString('hex')}`)

    expect(redactEgress(`late ${CLERK_KEY}`)).toContain(CLERK_KEY)
  })
})

describe('registerPrivateKey', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pems = {
    pkcs1: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    pkcs8: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
  const bodyLines = (pem: string) =>
    pem
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('-----'))
  /** The PEM without its BEGIN/END lines, which `redactCredentials` would otherwise scrub whole. */
  const bodyOf = (pem: string) => bodyLines(pem).join('\n')
  const holdsNoBodyLine = (text: string, pem: string) => {
    const lines = bodyLines(pem)
    expect(lines.length).toBeGreaterThan(10)
    for (const line of lines) expect(text).not.toContain(line)
  }

  describe.each(Object.entries(pems))('a %s key', (_name, pem) => {
    beforeEach(() => {
      registerPrivateKey(pem)
    })

    it.each([
      ['the PEM itself', (text: string) => text],
      ['JSON-escaped', (text: string) => JSON.stringify(text)],
      [
        'with newlines as the two characters backslash-n',
        (text: string) => text.replace(/\n/g, '\\n'),
      ],
    ])('scrubs every body line from %s, with or without its BEGIN/END lines', (_form, render) => {
      holdsNoBodyLine(redactEgress(`key: ${render(pem)} done`), pem)
      holdsNoBodyLine(redactEgress(`key: ${render(bodyOf(pem))} done`), pem)
    })

    it('scrubs every body line from an answer, which is never scrubbed by pattern', () => {
      const scrubbed = redactValue({ detail: pem, lines: bodyLines(pem) })

      holdsNoBodyLine(JSON.stringify(scrubbed).replace(/\\n/g, '\n'), pem)
    })
  })

  it('scrubs a key registered from its literal backslash-n form', () => {
    const pem = pems.pkcs8
    registerPrivateKey(pem.replace(/\n/g, '\\n'))

    holdsNoBodyLine(redactEgress(bodyOf(pem)), pem)
  })

  it('scrubs a base64-wrapped PEM registered as given', () => {
    const wrapped = Buffer.from(pems.pkcs8).toString('base64')
    registerPrivateKey(wrapped)

    expect(wrapped).not.toContain('\n')
    expect(redactEgress(`config ${wrapped} end`)).not.toContain(wrapped.slice(0, 64))
  })

  /** A key no other test registered, so only the registration under test can scrub it. */
  const freshPem = () =>
    generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs1', format: 'pem' })
      .toString()

  it('scrubs the PEM a base64-wrapped key wraps from an answer', () => {
    const pem = freshPem()
    registerPrivateKey(Buffer.from(pem).toString('base64'))

    holdsNoBodyLine(JSON.stringify(redactValue({ lines: bodyLines(pem) })), pem)
  })

  it('scrubs a key registered from its literal backslash-r-backslash-n form from an answer', () => {
    const pem = freshPem()
    registerPrivateKey(pem.replace(/\n/g, '\\r\\n'))

    holdsNoBodyLine(JSON.stringify(redactValue({ lines: bodyLines(pem) })), pem)
  })

  it('is not evicted by registering more tokens than the token store holds', () => {
    registerPrivateKey(pems.pkcs1)
    for (let i = 0; i < 40; i++)
      registerLiveSecret(`CANARY-evict-${i}-${randomBytes(8).toString('hex')}`)

    holdsNoBodyLine(redactEgress(bodyOf(pems.pkcs1)), pems.pkcs1)
  })

  it('skips the BEGIN/END lines and lines under the secret floor', () => {
    registerPrivateKey('-----BEGIN PRIVATE KEY-----\nshort\n-----END PRIVATE KEY-----')

    expect(redactValue('short and -----BEGIN PRIVATE KEY----- stay')).toBe(
      'short and -----BEGIN PRIVATE KEY----- stay',
    )
  })
})
