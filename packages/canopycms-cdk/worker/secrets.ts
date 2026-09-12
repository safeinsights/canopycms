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

import { workerLog, workerLogWarn } from 'canopycms/worker/cms-worker'

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
 */
async function fetchSecretString(secretArn: string, retries: number): Promise<string> {
  const { SecretsManagerClient, GetSecretValueCommand } =
    await import('@aws-sdk/client-secrets-manager')
  const client = new SecretsManagerClient({})

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
      const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }))
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
  const { jsonField, jsonFieldEnvVar, retries = 3 } = options
  const secretString = await fetchSecretString(secretArn, retries)

  // Truthiness, not `=== undefined`: an env var that is set-but-empty arrives as
  // `''`, and "the operator left it blank" means "not configured", not "read the
  // field whose name is the empty string".
  if (!jsonField) {
    warnIfUnreadJsonDocument(secretArn, secretString, jsonFieldEnvVar)
    return secretString
  }

  return extractJsonField(secretArn, secretString, jsonField)
}
