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

import { workerLog } from 'canopycms/worker/cms-worker'

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

  // Clamped so a nonsensical negative `retries` still makes one call rather than
  // skipping the loop entirely and reporting a value problem for a secret that
  // was never fetched.
  const lastAttempt = Math.max(0, retries)

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

/**
 * Fetches the secret at `secretArn` and returns the credential it carries.
 *
 * Today's behaviour, unchanged: the secret's whole string value IS the
 * credential.
 */
export async function getSecret(secretArn: string, retries = 3): Promise<string> {
  return fetchSecretString(secretArn, retries)
}
