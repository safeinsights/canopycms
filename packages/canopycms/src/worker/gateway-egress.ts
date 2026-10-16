/**
 * What leaves the GitHub gateway: every error it throws, every answer it returns and every line it
 * logs goes through here, `github-service.ts`'s and Octokit's lines for it included (they are
 * given {@link gatewayLogWarn} and {@link gatewayLogError}), except `openBundle`'s errors, which
 * hold no secret. Each is scrubbed of every live token the gateway has resolved, in every form
 * git's extraheader gives it, and of the auth provider's key and the App's private key, as exact
 * strings. Errors and log lines are then scrubbed by
 * `redactCredentials`'s patterns too; answers are not, because they are data the worker acts on,
 * and a pattern would rewrite a GitHub branch named `chore/github_pat_rotation`. The
 * exact scrub comes first and cannot be left to the patterns: one can stop part-way through a
 * form beside another (at the `%` of a URL-encoded one) and leave its tail unmatchable. Each log
 * line also has its non-printable characters escaped, since request fields (branch names, pull
 * request text) and git's output (commit subjects) are attacker-chosen. The gateway process's own
 * modules (secret reads, the termination watch) and `@octokit/auth-app` log through `workerLog`
 * or the console, unscrubbed: none of their lines carries a secret's value.
 */
import { getErrorMessage, redactCredentials } from '../utils/error'
import { escapeForLog } from '../utils/escape-text'
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

/**
 * Scrub `value` from everything that leaves the gateway from now on, raw and URL-encoded: a secret
 * that is not a GitHub token (the auth provider's key). It shares {@link registerLiveSecret}'s
 * store and cap, so a rotated key's predecessor stays scrubbed until the cap drops it, as a
 * token's does.
 */
export function registerSecretText(value: string): void {
  if (value.length < MIN_SECRET_LENGTH) return
  liveSecrets.delete(value)
  liveSecrets.set(
    value,
    [...new Set([value, encodeURIComponent(value)])].sort((a, b) => b.length - a.length),
  )
  for (const oldest of liveSecrets.keys()) {
    if (liveSecrets.size <= MAX_LIVE_SECRETS) break
    liveSecrets.delete(oldest)
  }
}

/** How many private-key lines are scrubbed; the oldest are dropped past it. */
const MAX_PRIVATE_KEY_LINES = 1024

/**
 * The lines of every registered private key, in their own set: a PEM is about 27 lines and the
 * token store holds {@link MAX_LIVE_SECRETS}, so sharing it would evict live tokens.
 */
const privateKeyLines = new Set<string>()

/** `privateKeyLines`, longest first; rebuilt when a key is registered. */
let privateKeyLinesLongestFirst: string[] = []

/**
 * Scrub each line of a PEM key's body from everything that leaves the gateway from now on, so the
 * scrub survives JSON or log escaping, which split a PEM at its newlines. Lines split on real
 * line breaks and on the literal `\n`, `\r\n` or `\r` (a key pasted into a single-line config
 * field); the BEGIN/END lines and lines shorter than the secret floor are skipped. A key given as
 * one base64 line (a base64-wrapped PEM) is one entry, and the PEM it wraps is registered too.
 */
export function registerPrivateKey(pem: string): void {
  for (const raw of pem.split(/\r?\n|\r|(?:\\r)?\\n|\\r/)) {
    const line = raw.trim()
    if (line.length < MIN_SECRET_LENGTH || line.startsWith('-----')) continue
    privateKeyLines.delete(line)
    privateKeyLines.add(line)
    // A base64-wrapped PEM: the key inside it is the one a decoding consumer holds.
    const decoded = Buffer.from(line, 'base64').toString('utf8')
    if (decoded.includes('-----BEGIN')) registerPrivateKey(decoded)
  }
  for (const oldest of privateKeyLines) {
    if (privateKeyLines.size <= MAX_PRIVATE_KEY_LINES) break
    privateKeyLines.delete(oldest)
  }
  privateKeyLinesLongestFirst = [...privateKeyLines].sort((a, b) => b.length - a.length)
}

/** `text` without any live token or registered secret in any registered form. */
function redactLiveSecrets(text: string): string {
  let result = text
  for (const forms of liveSecrets.values()) {
    for (const form of forms) result = result.split(form).join('***')
  }
  for (const line of privateKeyLinesLongestFirst) result = result.split(line).join('***')
  return result
}

/** `text` without any live token in any registered form, or anything `redactCredentials` finds. */
export function redactEgress(text: string): string {
  return redactCredentials(redactLiveSecrets(text))
}

/** The deepest a returned value is walked; anything deeper passes as it is. */
const MAX_DEPTH = 8

/**
 * An answer with every string in it (a Map's keys included) scrubbed of live tokens, never by
 * pattern: the same object when nothing in it changed, else a copy. Plain data only: anything
 * else (a stream) is returned as it is.
 */
export function redactValue<T>(value: T): T {
  return redactAny(value, 0, redactLiveSecrets) as T
}

function redactAny(value: unknown, depth: number, scrub: (text: string) => string): unknown {
  if (typeof value === 'string') return scrub(value)
  if (depth >= MAX_DEPTH || typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) {
    const items = value.map((item) => redactAny(item, depth + 1, scrub))
    return items.every((item, i) => item === value[i]) ? value : items
  }
  if (value instanceof Map) {
    const before: [unknown, unknown][] = [...value]
    const after = before.map(([key, item]): [unknown, unknown] => [
      redactAny(key, depth + 1, scrub),
      redactAny(item, depth + 1, scrub),
    ])
    return after.every(([key, item], i) => key === before[i][0] && item === before[i][1])
      ? value
      : new Map(after)
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return value
  const entries = Object.entries(value)
  const redacted = entries.map(([key, item]) => [key, redactAny(item, depth + 1, scrub)] as const)
  return redacted.every(([, item], i) => item === entries[i][1])
    ? value
    : Object.fromEntries(redacted)
}

/**
 * `err` scrubbed for leaving the gateway: its message, stack and `stderr`, its `cause` chain, and
 * an Octokit error's `response` and `request`. Scrubbed in place, so its class and the fields the
 * task runner classifies on (`status`, `code`, `kind`) survive; a field that cannot be set (a
 * DOMException's message) makes it a plain Error of the same name instead. Only fields that hold a secret are
 * touched. A thrown string is scrubbed; anything else is returned as it is.
 */
export function redactError(err: unknown, depth = 0): unknown {
  if (typeof err === 'string') return redactEgress(err)
  if (!(err instanceof Error) || depth >= MAX_DEPTH) return err
  const fields = err as Error & Record<string, unknown>
  const updates: [string, unknown][] = []
  // `stderr`: a GitProcessError (worker/git-process.ts) carries git's own output beside its message.
  for (const key of ['message', 'stack', 'stderr']) {
    const value = fields[key]
    if (typeof value === 'string' && redactEgress(value) !== value) {
      updates.push([key, redactEgress(value)])
    }
  }
  for (const key of ['response', 'request']) {
    const redacted = redactAny(fields[key], 0, redactEgress)
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
