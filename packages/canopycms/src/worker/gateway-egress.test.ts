import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mockConsole, octokitErrorFor, type MockConsole } from '../test-utils'
import {
  escapeForLog,
  gatewayLogWarn,
  redactEgress,
  redactError,
  redactValue,
  registerLiveSecret,
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
