/**
 * Secrets Manager reads for the EC2 worker entrypoint.
 *
 * Lives in `canopycms-cdk`, NOT in `canopycms` core: core's `CmsWorker` is
 * documented as "Cloud-agnostic: uses git/Octokit directly, no AWS SDK
 * dependency" (packages/canopycms/src/worker/cms-worker.ts), and an
 * `@aws-sdk/client-secrets-manager` import there would end that. An adopter
 * wiring their own worker on another cloud writes their own equivalent of this
 * file; nothing in core reaches it.
 *
 * Split out of `index.ts` so it can be imported by a test at all: `index.ts`
 * ends in `main().catch(...)`, so importing it RUNS the worker.
 *
 * `workerLog*` come from `canopycms/worker/cms-worker`, the package's advertised
 * worker entrypoint, exactly as `index.ts` imports them — deliberately not via a
 * new package entrypoint, which `packages/canopycms/src/worker/AGENTS.md` marks
 * as a re-export that must survive any reshuffle.
 */

import type { SecretsManagerClientConfig } from '@aws-sdk/client-secrets-manager'
import { workerLog, workerLogWarn } from 'canopycms/worker/cms-worker'

/**
 * Bounds every network op `SecretsManagerClient` performs, so a stalled
 * endpoint fails instead of hanging forever.
 *
 * Measured against the installed `@aws-sdk/client-secrets-manager@3.1018.0`,
 * which resolves `@smithy/node-http-handler@4.5.0` (confirmed with
 * `pnpm why @smithy/node-http-handler` — `@aws-sdk/client-s3` in this same
 * package resolves a separate `4.9.9` copy, so this is specific to this
 * client). `new SecretsManagerClient({})` arms NO timeout at all in that
 * version: a probe against a `node:net` server that accepts the connection and
 * never writes a byte was still pending after 10s with zero options set
 * (1 connection made, `send` unsettled). Per-option probes against the same
 * server, and against a genuine SYN black hole for the handshake case
 * (loopback/reserved ranges get an immediate local EHOSTUNREACH on this
 * network and can't be used to test a hung *connection*):
 *   - `connectionTimeout: 1000` rejected at ~1021ms with `TimeoutError` when
 *     the TCP handshake never completed.
 *   - `socketTimeout: 1000` rejected at ~1023ms with `TimeoutError` on its own
 *     — no extra flag needed.
 *   - `requestTimeout: 1000` alone did NOT reject — after 5s it had only
 *     logged `@smithy/node-http-handler - [WARN] ... Init client
 *     requestHandler with throwOnRequestTimeout=true to turn this into an
 *     error.` (dist-cjs/index.js's `setRequestTimeout`). Adding
 *     `throwOnRequestTimeout: true` made the same 1000ms bound reject at
 *     ~1023ms.
 *   - Default `maxAttempts` resolves to 3 (`client.config.maxAttempts()`), and
 *     the SDK retries failures on its own: one failing `send()` against the
 *     black-holed server hit it 3 times. `maxAttempts: 1` cut that to exactly
 *     1 — required here because `fetchSecretString` below already owns retry
 *     and backoff, so the SDK's own retries would multiply it again.
 *
 * IMPORTANT — those three options do NOT add up to a bound on the whole call.
 * Measured with these exact production values against a real `http.Server`
 * that flushes valid response headers and then withholds the body (three
 * shapes: 10 bytes then silence, no body at all, one byte every 2s):
 * `@smithy/node-http-handler@4.5.0`'s `handle()` (dist-cjs/index.js) resolves
 * its promise the moment response HEADERS arrive and then clears every timer
 * it armed — `requestTimeout` included (the `resolve` wrapper at ~line
 * 277-279 does `timeouts.forEach(timing.clearTimeout)` before settling).
 * `socketTimeout` fares no better here: for any value ≥ 6000ms (production
 * uses 15000), `setSocketTimeout` (~line 144) does not call
 * `request.socket.setTimeout` immediately — it defers that call 3000ms behind
 * a `setTimeout` that is itself one of the timers `resolve` clears. Headers
 * routinely arrive inside that 3s window, so the deferred call never runs and
 * NO idle timeout is ever armed on the socket. Net effect: all three stall
 * shapes were still pending at 90s under these options with nothing above
 * bounding them; a fourth shape (headers 4s late, then a stall) was bounded
 * only by the *already-armed* socket timer, rejecting at ~16.1s
 * (15000 − 3000 deferred + 4000 late-headers ≈ 16000).
 *
 * The actual per-attempt, whole-call bound is `fetchSecretString`'s
 * `attemptTimeoutMs` (see `DEFAULT_ATTEMPT_TIMEOUT_MS` below): each
 * `client.send(...)` there passes `{ abortSignal:
 * AbortSignal.timeout(attemptTimeoutMs) }`. Measured against the same server
 * and the same production requestHandler options above, that rejected all
 * three stall shapes in ~2000-2013ms (an ordinary `Error`, message
 * `"aborted"`, wrapped by the SDK's response deserialization) with the
 * socket destroyed (0 sockets left open server-side afterward), and left a
 * normal fast response untouched (resolved in 25ms with the same signal
 * armed). `Promise.race([client.send(...), timer]) + client.destroy()` on
 * the loser was measured too and also works — the losing promise settles
 * (rejects) within a few ms of `destroy()`, no unhandled rejection — but
 * needs nothing extra here: a client whose `send()` was raced away and then
 * `destroy()`-ed was measured to `send()` successfully again in ~10ms once
 * the endpoint recovered, so a fresh client per attempt is not required
 * either way. `AbortSignal.timeout` was chosen over the race because it is
 * less code for the same measured result.
 *
 * Chosen bounds: a `connectionTimeout` of a few seconds (the handshake should
 * be near-instant against a healthy endpoint) and a `requestTimeout` —
 * `throwOnRequestTimeout: true` so it actually fires per the measurement above
 * — in the 10-20s range as the bound on time to response headers, plus
 * `socketTimeout` at the same bound as a second, independent trip wire for
 * the < 6s branch above (a connection that goes quiet before headers arrive).
 * None of the three bound a stalled body, per the measurement above —
 * `attemptTimeoutMs` is what does. With `maxAttempts: 1`, one
 * `fetchSecretString` call (default `retries: 3`, so up to 4 attempts,
 * default `attemptTimeoutMs: 20_000`) has a worst case of
 * `4 × attemptTimeoutMs + (1s + 2s + 4s backoff) = 87s` when every attempt
 * hangs — bounded, including a stalled body, versus previously unbounded on
 * that path (and previously up to `4 × 3 = 12` transport attempts per
 * `getSecret`, per `credential-refresh.ts`'s cost arithmetic, before this
 * change).
 */
export function secretsManagerClientConfig(
  timeouts: { connectionTimeout?: number; requestTimeout?: number } = {},
): SecretsManagerClientConfig {
  const { connectionTimeout = 3_000, requestTimeout = 15_000 } = timeouts
  return {
    requestHandler: {
      connectionTimeout,
      requestTimeout,
      throwOnRequestTimeout: true,
      socketTimeout: requestTimeout,
    },
    // fetchSecretString below is the retry authority; see its own comment.
    maxAttempts: 1,
  }
}

/**
 * Default per-attempt deadline for one `client.send(...)` call inside
 * `fetchSecretString`'s retry loop — the bound that covers the WHOLE call,
 * response body included, per the measurement above `secretsManagerClientConfig`.
 * Chosen to sit above that function's default `requestTimeout` (15000ms): a
 * live endpoint that is merely slow, and still within its own request
 * timeout, should not be cut off first by a shorter attempt deadline.
 * Injectable via `GetSecretOptions.attemptTimeoutMs` so tests can use a short
 * one; production code should not need to set it.
 */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 20_000

/**
 * Reads a secret's string value, retrying only TRANSPORT failures.
 *
 * The retry loop is deliberately narrow: it covers `client.send` throwing
 * (throttling, a cold IMDS credential chain, EC2 network still settling at
 * boot) and nothing else. Anything about the VALUE we got back is decided after
 * the loop, where it costs one call and fails immediately.
 *
 * That split is the point of this function's existence. When the value check sat
 * inside the `try` — as `if (!response.SecretString) throw` did — a secret that
 * was simply the wrong shape was re-fetched four times with 1s/2s/4s backoff and
 * then reported as a failure on "attempt 4", turning a deterministic
 * misconfiguration into a seven-second boot stall that reads like an outage.
 *
 * @param retries number of retries AFTER the first call, so the default 3 means
 *   up to 4 `GetSecretValue` calls.
 * @param attemptTimeoutMs per-attempt deadline (ms) passed to each `client.send`
 *   as an `AbortSignal.timeout`, covering that whole call including a stalled
 *   response body — see `DEFAULT_ATTEMPT_TIMEOUT_MS` and the measurement above
 *   `secretsManagerClientConfig`.
 */
async function fetchSecretString(
  secretArn: string,
  retries: number,
  attemptTimeoutMs: number,
): Promise<string> {
  const { SecretsManagerClient, GetSecretValueCommand } =
    await import('@aws-sdk/client-secrets-manager')
  const client = new SecretsManagerClient(secretsManagerClientConfig())

  // Normalized so the loop ALWAYS terminates through `break` or `throw`, never
  // by falling out of the condition, and never without bound. Three shapes,
  // measured against the pre-normalization `Math.max(0, retries)`:
  //   NaN      — `0 <= NaN` is false, so the loop body never ran AT ALL, and it
  //              then reported "has no string value" for a secret never fetched;
  //   1.5      — `attempt === lastAttempt` was never true, so the real SDK error
  //              was never rethrown; it slept 1s+2s and reported the same
  //              value-shaped error for a transport failure;
  //   Infinity — retried forever, with the delay doubling each time.
  // Every finite non-negative integer, and every negative value, is unaffected:
  // the default (3) is 4 calls at 1s/2s/4s before and after.
  const lastAttempt = Number.isFinite(retries) ? Math.max(0, Math.floor(retries)) : 0

  let secretString: string | undefined
  for (let attempt = 0; attempt <= lastAttempt; attempt++) {
    try {
      // A fresh AbortSignal.timeout() every iteration: a single one created
      // before the loop would already be expired by a later retry. Measured
      // (see the comment above `secretsManagerClientConfig`) to bound the
      // WHOLE send — a stalled response body included — by destroying the
      // socket and rejecting with an ordinary Error, which the catch below
      // treats like any other transport failure.
      const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }), {
        abortSignal: AbortSignal.timeout(attemptTimeoutMs),
      })
      secretString = response.SecretString
      break
    } catch (err) {
      if (attempt === lastAttempt) throw err
      const delay = 1000 * Math.pow(2, attempt) // 1s, 2s, 4s
      workerLog(`Secrets Manager unavailable for ${secretArn}, retrying in ${delay}ms...`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  // Outside the loop: a binary secret (`SecretBinary`, no `SecretString`) is not
  // going to become a string on a second read.
  if (!secretString) {
    throw new Error(`Secret ${secretArn} has no string value`)
  }
  return secretString
}

/** A parsed JSON object — the only shape a credential *document* can take. */
type JsonObject = Record<string, unknown>

/**
 * Arrays are excluded deliberately. `typeof [] === 'object'`, but an array has
 * no field to name, so treating it as a credential document would produce
 * either a nonsense warning or an error about a missing key in something that
 * has no keys.
 */
function asJsonObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

/** `JSON.parse`, reduced to "did it parse, and to what" — never throws. */
function tryParseJson(raw: string): { parsed: unknown } | undefined {
  try {
    return { parsed: JSON.parse(raw) }
  } catch {
    return undefined
  }
}

/**
 * Key NAMES only, quoted and comma-joined. Never a value: these strings go into
 * error messages and into `/var/log/canopy-worker/worker.log`, which the
 * CloudWatch agent ships off the instance, and the values here are credentials.
 */
function describeKeys(doc: JsonObject): string {
  const keys = Object.keys(doc)
  return keys.length === 0 ? '(none)' : keys.map((k) => `"${k}"`).join(', ')
}

/**
 * What a value IS, for an error message. `null` and arrays both read as
 * "object" under `typeof`, which is useless to whoever has to fix the secret.
 * The article is computed rather than hardcoded because `typeof` yields both
 * `object` and `undefined`, and "a object" reads like a typo in the tool.
 */
function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  const type = typeof value
  return `${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`
}

/**
 * Pulls one field out of a secret that is expected to be a JSON document.
 *
 * Every off-path throws, and every message names the ARN, the field asked for,
 * and — where we have them — the keys actually present. A field name that is
 * simply a typo is the likeliest failure here, and "no field X; keys present
 * are Y, Z" is the difference between a 30-second fix and an afternoon.
 */
function extractJsonField(secretArn: string, secretString: string, jsonField: string): string {
  const result = tryParseJson(secretString)
  if (!result) {
    throw new Error(
      `Secret ${secretArn} is configured to read JSON field "${jsonField}", but its value is not valid JSON. ` +
        `Either store a JSON document in this secret, or unset the JSON-field setting to use the whole value as the credential.`,
    )
  }

  const doc = asJsonObject(result.parsed)
  if (!doc) {
    throw new Error(
      `Secret ${secretArn} is configured to read JSON field "${jsonField}", but its value is ${describeType(result.parsed)}, not a JSON object.`,
    )
  }

  // An own-property check, not `doc[field] !== undefined`: JSON cannot express
  // an `undefined` value, so "does this key exist" is the exact question — and
  // it does not read inherited members, so a field named `constructor` or
  // `toString` reports "no such field" instead of returning a function.
  // `hasOwnProperty.call` rather than `Object.hasOwn` because the compile target
  // is ES2021 and `Object.hasOwn` is ES2022.
  if (!Object.prototype.hasOwnProperty.call(doc, jsonField)) {
    throw new Error(
      `Secret ${secretArn} has no field "${jsonField}". Keys present: ${describeKeys(doc)}.`,
    )
  }

  const value = doc[jsonField]
  if (typeof value !== 'string') {
    throw new Error(
      `Secret ${secretArn} field "${jsonField}" is ${describeType(value)}, not a string. A credential must be a JSON string value.`,
    )
  }

  // An empty credential is rejected here for the same reason `fetchSecretString`
  // rejects an empty `SecretString`: it is not a credential, and every caller
  // downstream treats it as absent — silently. `main()` would report
  // "CANOPYCMS_GITHUB_TOKEN or ..._SECRET_ARN is required" while the ARN plainly
  // is set, and an empty Clerk key leaves `refreshAuthCache` undefined, which
  // disables auth-cache refresh with no log line at all. Both are exactly the
  // class of silent failure this change exists to end.
  if (value === '') {
    throw new Error(
      `Secret ${secretArn} field "${jsonField}" is an empty string. Set a value for it, or point at a different field.`,
    )
  }
  return value
}

/**
 * Warns when a secret holds a JSON document but nothing asked for a field of it.
 *
 * This is the half of adopter request #46 that helps the adopter who has not yet
 * read the docs, and it is the actual complaint: not "there is no field option"
 * but "nothing told me". Without it, the whole document silently becomes the
 * credential and the first symptom is Clerk rejecting a key, or git rejecting a
 * URL, a long way from the cause.
 *
 * It does not fire on any credential this worker reads: a GitHub PAT (`ghp_…`),
 * an installation token (`ghs_…`), a Clerk secret key (`sk_live_…`/`sk_test_…`)
 * and a PEM private key are none of them valid JSON, so the parse fails and
 * nothing is logged. The object check also excludes scalars — a secret whose
 * value is `42` or `"x"` parses fine but is not a credential document and gets
 * no warning. A credential that WAS a bare JSON object would warn, which is the
 * intended behaviour rather than a false positive: the whole document is in fact
 * being used as the credential at that point.
 */
function warnIfUnreadJsonDocument(
  secretArn: string,
  secretString: string,
  jsonFieldEnvVar: string | undefined,
): void {
  const result = tryParseJson(secretString)
  if (!result) return
  const doc = asJsonObject(result.parsed)
  if (!doc) return

  const setting = jsonFieldEnvVar
    ? `Set ${jsonFieldEnvVar} to the field you want`
    : 'Configure the JSON field for this secret'
  const example = jsonFieldEnvVar
    ? ` (for example ${jsonFieldEnvVar}=${Object.keys(doc)[0] ?? 'FIELD_NAME'}).`
    : '.'

  workerLogWarn(
    `Secret ${secretArn} holds a JSON object with keys ${describeKeys(doc)}, but no JSON field is ` +
      `configured — so the ENTIRE JSON document is being used as the credential, which is almost ` +
      `certainly not what you want. ${setting}${example}`,
  )
}

export interface GetSecretOptions {
  /**
   * Read this field out of the secret instead of using the whole value.
   *
   * Omitted (or empty, which is how an unset env var arrives) means today's
   * behaviour: the secret's whole string value IS the credential, returned
   * verbatim. A parse IS still attempted on that path — that is what
   * `warnIfUnreadJsonDocument` does — but it can only produce a log line, never
   * change the returned bytes.
   */
  jsonField?: string
  /**
   * Name of the env var that sets `jsonField`, quoted back in the warning when a
   * JSON document is found with no field configured. Without it the warning can
   * only say "configure the JSON field", which is not actionable.
   */
  jsonFieldEnvVar?: string
  /** Retries AFTER the first call, so the default 3 means up to 4 calls. */
  retries?: number
  /**
   * Per-attempt deadline (ms) for one `client.send(...)` call, covering the
   * whole call including a stalled response body. Defaults to
   * `DEFAULT_ATTEMPT_TIMEOUT_MS`; internal knob mainly so tests can use a
   * short one — see the measurement above `secretsManagerClientConfig`.
   */
  attemptTimeoutMs?: number
}

/**
 * Fetches the secret at `secretArn` and returns the credential it carries.
 *
 * With no `jsonField`, this is byte-for-byte what it has always been: the
 * secret's whole string value. That path is pinned by a regression test, because
 * every adopter who exists today is on it.
 */
export async function getSecret(
  secretArn: string,
  options: GetSecretOptions = {},
): Promise<string> {
  const {
    jsonField,
    jsonFieldEnvVar,
    retries = 3,
    attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
  } = options
  const secretString = await fetchSecretString(secretArn, retries, attemptTimeoutMs)

  // Truthiness, not `=== undefined`: an env var that is set-but-empty arrives as
  // `''`, and "the operator left it blank" means "not configured", not "read the
  // field whose name is the empty string".
  if (!jsonField) {
    warnIfUnreadJsonDocument(secretArn, secretString, jsonFieldEnvVar)
    return secretString
  }

  return extractJsonField(secretArn, secretString, jsonField)
}
