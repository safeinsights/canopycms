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
 * Transport options for the worker's `SecretsManagerClient`.
 *
 * For `@aws-sdk/client-secrets-manager@3.1018.0` → `@smithy/node-http-handler@4.5.0`
 * (`@aws-sdk/client-s3` in this package resolves 4.9.9; re-check on any bump):
 * - `new SecretsManagerClient({})` arms no timer at all: a send to a server
 *   that accepts the connection and never answers never settles.
 * - `requestTimeout` only logs a WARN unless `throwOnRequestTimeout: true`
 *   (dist-cjs/index.js, `setRequestTimeout`, ~81-100).
 * - `maxAttempts` defaults to 3 and the SDK retries on its own; it is 1 here
 *   because `fetchSecretString` owns retry and backoff.
 * - None of these bounds a response BODY. `handle()` resolves on headers and
 *   clears every timer it armed (~277-285), and a `socketTimeout` of 6000ms or
 *   more is armed only after a 3000ms deferral that is itself one of those
 *   timers (`setSocketTimeout`, ~125-144). So before headers arrive,
 *   `requestTimeout` rejects at ~15s (`connectionTimeout` at 3s for a handshake
 *   that never completes); once headers arrive inside that 3s deferral, the
 *   normal case, only `fetchSecretString`'s per-attempt `AbortSignal.timeout`
 *   (`DEFAULT_ATTEMPT_TIMEOUT_MS`) bounds the call, by destroying the socket.
 *
 * Worst case for one `getSecret` with the defaults (4 attempts × 20s, plus
 * 1s + 2s + 4s of backoff): 87s.
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
 * response body included, per the comment above `secretsManagerClientConfig`.
 * Chosen to sit above that function's default `requestTimeout` (15000ms): a
 * live endpoint that is merely slow, and still within its own request
 * timeout, should not be cut off first by a shorter attempt deadline.
 * Injectable via `GetSecretOptions.attemptTimeoutMs` so tests can use a short
 * one; production code should not need to set it.
 */
const DEFAULT_ATTEMPT_TIMEOUT_MS = 20_000

/** The largest delay `AbortSignal.timeout` accepts without silently clamping. */
const MAX_ATTEMPT_TIMEOUT_MS = 2_147_483_647

/**
 * Reads a secret's string value, retrying every failure of `client.send`.
 *
 * The retry covers `client.send` throwing, whatever the cause — transport,
 * throttling, a cold IMDS credential chain, EC2 network still settling at boot,
 * and service errors alike, `AccessDeniedException` included — and logs each as
 * "Secrets Manager unavailable". Anything about the VALUE we got back is decided
 * after the loop, where it costs one call and fails immediately.
 *
 * That split is the point of this function. A value check inside the `try` makes
 * a secret that is simply the wrong shape get re-fetched four times with
 * 1s/2s/4s backoff and then reported as a failure on "attempt 4", turning a
 * deterministic misconfiguration into a seven-second boot stall that reads like
 * an outage.
 *
 * @param retries number of retries AFTER the first call, so the default 3 means
 *   up to 4 `GetSecretValue` calls.
 * @param attemptTimeoutMs per-attempt deadline (ms) passed to each `client.send`
 *   as an `AbortSignal.timeout`, covering that whole call including a stalled
 *   response body — see `DEFAULT_ATTEMPT_TIMEOUT_MS` and the comment above
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
  // by falling out of the condition and never without bound. With a plain
  // `Math.max(0, retries)` three shapes break it: NaN makes `0 <= NaN` false so
  // the body never runs at all and "has no string value" is reported for a
  // secret never fetched; 1.5 never satisfies `attempt === lastAttempt`, so the
  // real SDK error is never rethrown and a transport failure is reported as that
  // same value-shaped error; Infinity retries forever with the delay doubling.
  // Every finite non-negative integer and every negative value is unaffected.
  const lastAttempt = Number.isFinite(retries) ? Math.max(0, Math.floor(retries)) : 0

  let secretString: string | undefined
  for (let attempt = 0; attempt <= lastAttempt; attempt++) {
    try {
      // A fresh AbortSignal.timeout() every iteration: a single one created
      // before the loop would already be expired by a later retry. Measured
      // (see the comment above `secretsManagerClientConfig`) to bound the
      // WHOLE send — a stalled response body included — by destroying the
      // socket and rejecting with an ordinary Error, which the catch below
      // retries like any other failed send.
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
  // rejects an empty `SecretString`: every caller downstream treats it as absent,
  // silently. `main()` would report "CANOPYCMS_GITHUB_TOKEN or ..._SECRET_ARN is
  // required" while the ARN plainly is set, and an empty Clerk key leaves
  // `refreshAuthCache` undefined, disabling auth-cache refresh with no log line.
  if (value === '') {
    throw new Error(
      `Secret ${secretArn} field "${jsonField}" is an empty string. Set a value for it, or point at a different field.`,
    )
  }
  return value
}

/**
 * Warns when a secret holds a JSON document but nothing asked for a field of it.
 * Without this the whole document silently becomes the credential, and the first
 * symptom is Clerk rejecting a key or git rejecting a URL, a long way from the
 * cause.
 *
 * It does not fire on any credential this worker reads: a GitHub PAT (`ghp_…`),
 * an installation token (`ghs_…`), a Clerk secret key (`sk_live_…`/`sk_test_…`)
 * and a PEM private key are none of them valid JSON, so the parse fails and
 * nothing is logged. The object check also excludes scalars — `42` or `"x"`
 * parses fine but is not a credential document. A credential that IS a bare JSON
 * object does warn, which is intended rather than a false positive: the whole
 * document is in fact being used as the credential at that point.
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
   * short one — see the comment above `secretsManagerClientConfig`.
   */
  attemptTimeoutMs?: number
}

/**
 * Fetches the secret at `secretArn` and returns the credential it carries.
 *
 * With no `jsonField` the result is the secret's whole string value, byte for
 * byte - the path nearly every deployment is on, and pinned by a regression
 * test.
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
  // Checked before any network call, not left to `AbortSignal.timeout` inside
  // `fetchSecretString`'s try: there NaN, Infinity, a fraction, a negative or
  // anything above 2**32-1 throws a RangeError, and 0 or 2**31…2**32-1 aborts
  // every attempt at once. The catch reads either as a transport failure, so it
  // retries with backoff and logs "Secrets Manager unavailable" -- the exact
  // misdiagnosis `fetchSecretString` exists to prevent. Same bounds as
  // `gitTokenMintTimeoutMs` in canopycms core (github-auth.ts).
  if (
    !Number.isInteger(attemptTimeoutMs) ||
    attemptTimeoutMs < 1 ||
    attemptTimeoutMs > MAX_ATTEMPT_TIMEOUT_MS
  ) {
    throw new Error(
      `getSecret: attemptTimeoutMs must be a whole number of milliseconds between 1 and ${MAX_ATTEMPT_TIMEOUT_MS} (got ${String(attemptTimeoutMs)}).`,
    )
  }
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
