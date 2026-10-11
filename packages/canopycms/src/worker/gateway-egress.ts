/**
 * What leaves the GitHub gateway: every error it throws, every answer it returns and every line it
 * logs goes through here. Each is scrubbed of every live token the gateway has resolved, in every
 * form git's extraheader gives it, as exact strings, then by `redactCredentials`'s patterns. The
 * exact scrub comes first and cannot be left to the patterns: one can stop part-way through a
 * form beside another (at the `%` of a URL-encoded one) and leave its tail unmatchable. Each log
 * line also has its non-printable characters escaped, since request fields (branch names, pull
 * request text) and git's output (commit subjects) are attacker-chosen.
 */
import { getErrorMessage, redactCredentials } from '../utils/error'
import { workerLog, workerLogError, workerLogWarn } from './log'

/** How many tokens are scrubbed: the current one and those it replaced. */
const MAX_LIVE_SECRETS = 32

/** Shorter values are never scrubbed as exact strings: they would hit ordinary text. */
const MIN_SECRET_LENGTH = 8

/** Each live token's forms, longest first; the most recently registered token last. */
const liveSecrets = new Map<string, string[]>()

/**
 * Scrub `token` from everything that leaves the gateway from now on: raw, and as the extraheader
 * carries it, `base64("x-access-token:" + token)`, raw and URL-encoded. Shared by every gateway in
 * the process, so a token one resolved is scrubbed from all of them.
 */
export function registerLiveSecret(token: string): void {
  if (token.length < MIN_SECRET_LENGTH) return
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  liveSecrets.delete(token)
  liveSecrets.set(
    token,
    [...new Set([token, basic, encodeURIComponent(basic)])].sort((a, b) => b.length - a.length),
  )
  for (const oldest of liveSecrets.keys()) {
    if (liveSecrets.size <= MAX_LIVE_SECRETS) break
    liveSecrets.delete(oldest)
  }
}

/** `text` without any live token in any registered form, or anything `redactCredentials` finds. */
export function redactEgress(text: string): string {
  let result = text
  for (const forms of liveSecrets.values()) {
    for (const form of forms) result = result.split(form).join('***')
  }
  return redactCredentials(result)
}

/** The deepest a returned value is walked; anything deeper passes as it is. */
const MAX_DEPTH = 8

/**
 * `value` with every string in it (a Map's keys included) passed through {@link redactEgress}: the
 * same object when nothing in it changed, else a copy. Plain data only: anything else (a stream)
 * is returned as it is.
 */
export function redactValue<T>(value: T, depth = 0): T {
  return redactAny(value, depth) as T
}

function redactAny(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactEgress(value)
  if (depth >= MAX_DEPTH || typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) {
    const items = value.map((item) => redactAny(item, depth + 1))
    return items.every((item, i) => item === value[i]) ? value : items
  }
  if (value instanceof Map) {
    const before: [unknown, unknown][] = [...value]
    const after = before.map(([key, item]): [unknown, unknown] => [
      redactAny(key, depth + 1),
      redactAny(item, depth + 1),
    ])
    return after.every(([key, item], i) => key === before[i][0] && item === before[i][1])
      ? value
      : new Map(after)
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return value
  const entries = Object.entries(value)
  const redacted = entries.map(([key, item]) => [key, redactAny(item, depth + 1)] as const)
  return redacted.every(([, item], i) => item === entries[i][1])
    ? value
    : Object.fromEntries(redacted)
}

/**
 * `err` scrubbed for leaving the gateway: its message and stack, its `cause` chain, and an Octokit
 * error's `response` and `request`. Scrubbed in place, so its class and the fields the task runner
 * classifies on (`status`, `code`, `kind`) survive; a field that cannot be set (a DOMException's
 * message) makes it a plain Error of the same name instead. Only fields that hold a secret are
 * touched. A thrown string is scrubbed; anything else is returned as it is.
 */
export function redactError(err: unknown, depth = 0): unknown {
  if (typeof err === 'string') return redactEgress(err)
  if (!(err instanceof Error) || depth >= MAX_DEPTH) return err
  const fields = err as Error & Record<string, unknown>
  const updates: [string, unknown][] = []
  for (const key of ['message', 'stack']) {
    const value = fields[key]
    if (typeof value === 'string' && redactEgress(value) !== value) {
      updates.push([key, redactEgress(value)])
    }
  }
  for (const key of ['response', 'request']) {
    const redacted = redactValue(fields[key])
    if (redacted !== fields[key]) updates.push([key, redacted])
  }
  if (fields.cause !== undefined) {
    const cause = redactError(fields.cause, depth + 1)
    if (cause !== fields.cause) updates.push(['cause', cause])
  }
  try {
    for (const [key, value] of updates) {
      Object.defineProperty(fields, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: Object.prototype.propertyIsEnumerable.call(fields, key),
      })
    }
    return err
  } catch {
    const replacement = new Error(redactEgress(err.message))
    replacement.name = err.name
    return replacement
  }
}

/**
 * `text` on one line, every character outside printable ASCII escaped (`\n`, `\t`, `\r`, `\xHH`,
 * `\u{H}`), and `\` doubled so an escape cannot be forged. Bidi controls and zero-width characters
 * are outside printable ASCII too, so a branch name cannot reorder or hide part of a line.
 * @internal Exported for tests.
 */
export function escapeForLog(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\\') out += '\\\\'
    else if (code >= 0x20 && code <= 0x7e) out += char
    else if (char === '\n') out += '\\n'
    else if (char === '\t') out += '\\t'
    else if (char === '\r') out += '\\r'
    else if (code <= 0xff) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += `\\u{${code.toString(16)}}`
  }
  return out
}

function logLine(args: unknown[]): string {
  return escapeForLog(
    redactEgress(
      args.map((arg) => (typeof arg === 'string' ? arg : getErrorMessage(arg))).join(' '),
    ),
  )
}

/** The gateway's `workerLog`: one scrubbed, escaped line. */
export function gatewayLog(...args: unknown[]): void {
  workerLog(logLine(args))
}

/** The gateway's `workerLogWarn`: one scrubbed, escaped line. */
export function gatewayLogWarn(...args: unknown[]): void {
  workerLogWarn(logLine(args))
}

/** The gateway's `workerLogError`: one scrubbed, escaped line. */
export function gatewayLogError(...args: unknown[]): void {
  workerLogError(logLine(args))
}
