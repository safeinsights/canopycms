/**
 * The Clerk auth-cache refresher the EC2 worker hands to `CmsWorker`, with a
 * re-read of the secret key when Clerk rejects the one in hand.
 *
 * **Why the retry is HERE and not in core.** `CmsWorker.refreshAuthCache()`
 * catches and logs everything its callback throws, so a retry inside core would
 * sit downstream of a `catch` that has already swallowed the failure and would
 * never see the 401 it is meant to react to. The callback is the last point
 * where the error is still visible. Do not "tidy" this into core without first
 * making `refreshAuthCache()` propagate — see
 * safeinsights/canopycms#794.
 *
 * The same gate serves the GitHub gateway process, which holds the key and
 * hands the snapshot to the worker (`createClerkSnapshotFetcher`); the worker
 * writes it, so the fetch and the write are separate halves.
 *
 * Split out of `index.ts` so it can be imported by a test at all: `index.ts`
 * ends in `main().catch(...)`, so importing it RUNS the worker. Same split, and
 * same reason, as `secrets.ts` and `github-app-auth.ts`.
 */

import { workerLog, workerLogWarn, workerLogError } from 'canopycms/worker/cms-worker'
import { fetchClerkSnapshot, refreshClerkCache } from 'canopycms-auth-clerk/cache-writer'
import type { AuthCacheSnapshot } from 'canopycms/auth/cache'
import { getErrorMessage, redactCredentials } from 'canopycms/utils/error'

import type { ReactiveSecret } from './credential-refresh'

/**
 * Does this failure look like Clerk refusing the key, as opposed to Clerk
 * having a bad day?
 *
 * **This gate is the one guard the GitHub half does not need, and the asymmetry
 * is deliberate.** `refreshClerkCache` paginates every user, every
 * organisation and every membership — so retrying it on any
 * failure would double that entire workload on every transient 5xx or network
 * blip. The GitHub side has no comparable workload behind its retry (there the
 * "retry" is the task's next attempt or the next scheduled sync), which is why
 * it re-reads unconditionally and this does not.
 *
 * Read STRUCTURALLY off `.status`, not by `instanceof ClerkAPIResponseError`:
 * `@clerk/backend` is a peer dependency here, so an adopter can resolve a
 * different copy than this package's tests see, and an `instanceof` across two
 * copies is silently false. `isPermanentTaskFailure` and
 * `isTransientAuthFailure` in core use the same shape check for the same reason.
 * `.status` is there to be read (verified against `@clerk/backend@3.17.1`: every
 * API method resolves through `withLegacyRequestReturn`, which throws
 * `ClerkAPIResponseError(statusText, { status, ... })` on a non-2xx, and the
 * class declares `status: number` publicly). Its MESSAGE is `statusText || ''`
 * and so can be empty - one more reason not to match on text.
 *
 * 403 as well as 401: Clerk answers a revoked key with 401, but a key belonging
 * to a different instance, or one whose permissions were narrowed, can come
 * back 403 — and both mean "this key will not work, try a different one", which
 * is exactly the condition a rotation fixes.
 */
function isClerkAuthRejection(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('status' in err)) return false
  const status = (err as { status: unknown }).status
  return status === 401 || status === 403
}

/** Where the retry gate's lines go: the worker's loggers, or the gateway's scrubbing ones. */
export interface ClerkRefreshLog {
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

const WORKER_LOG: ClerkRefreshLog = { warn: workerLogWarn, error: workerLogError }

/**
 * Run `attempt` with `key`, and on a Clerk rejection of it retry ONCE with the key re-read from
 * `secret`. Both halves of the refresh share this, so the gate above exists once.
 */
async function withKeyReread<T>(
  secret: ReactiveSecret,
  key: string,
  log: ClerkRefreshLog,
  attempt: (secretKey: string) => Promise<T>,
): Promise<T> {
  try {
    return await attempt(key)
  } catch (err) {
    if (!isClerkAuthRejection(err)) throw err

    // The re-read is best-effort, and its own failure must NEVER replace the
    // Clerk rejection being handled. Without the inner try, an IAM policy
    // narrowed after boot turns every tick into an AccessDeniedException and
    // the 401 that actually explains the stale cache is never logged - at the
    // default 15-minute auth-cache interval, indefinitely, since every tick
    // clears the reader's own 5-minute floor and re-attempts the read. Core's
    // GitHub gateway keeps a failed GitHub re-read from replacing the failure
    // it follows for the same reason; this is the Clerk half of it.
    let rotated: string | undefined
    try {
      rotated = await secret.refresh()
    } catch (refreshErr) {
      // [REDACT] `getSecret`'s messages carry key NAMES, never values -- but
      // this line is one edit away from carrying a value, and the rule in
      // this repo is uniform rather than case-by-case. Note it is not
      // sufficient on its own: a Clerk `sk_live_…` matches none of
      // redactCredentials' current rules (see
      // safeinsights/canopycms#794).
      log.error(
        'Failed to re-read the Clerk secret key after Clerk rejected it:',
        redactCredentials(getErrorMessage(refreshErr)),
      )
      throw err
    }

    // `undefined` means nothing to do -- no ARN, re-read too recently, or a
    // value identical to the one Clerk just refused. In all three the retry
    // below cannot succeed, so rethrow the original rejection rather than
    // paying for a second guaranteed failure.
    if (rotated === undefined) throw err

    log.warn(
      'Clerk rejected the secret key; the key in Secrets Manager has since changed. Retrying with it.',
    )
    // ONCE. A second rejection is the new key's problem and belongs in the
    // log as a plain failure -- retrying around the re-read would turn a
    // wrong key into a loop over Clerk's entire user list.
    return await attempt(rotated)
  }
}

/** The environment variable `parseClerkOrganizationsAsGroups` reads. */
export const CLERK_ORGANIZATIONS_AS_GROUPS_ENV = 'CANOPYCMS_CLERK_ORGANIZATIONS_AS_GROUPS'

/**
 * `CANOPYCMS_CLERK_ORGANIZATIONS_AS_GROUPS` as a boolean: unset or empty is `true`, and anything
 * but `true` or `false` throws, so a typo fails the boot rather than silently picking a side.
 */
export function parseClerkOrganizationsAsGroups(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const value = env[CLERK_ORGANIZATIONS_AS_GROUPS_ENV]
  if (value === undefined || value === '' || value === 'true') return true
  if (value === 'false') return false
  throw new Error(
    `${CLERK_ORGANIZATIONS_AS_GROUPS_ENV} is ${JSON.stringify(value)}, but it must be true or false`,
  )
}

export interface ClerkRefresherOptions {
  /** The Clerk secret key, re-readable when Clerk rejects it. */
  secret: ReactiveSecret
  /** Whether Clerk Organizations become Canopy groups; see {@link parseClerkOrganizationsAsGroups}. */
  useOrganizationsAsGroups: boolean
  /** Where the cache snapshot is written (`<workspace>/.cache`). */
  cachePath: string
}

/**
 * Build the `refreshAuthCache` callback, or `undefined` when no Clerk key is
 * configured at all.
 *
 * `undefined` is meaningful to `CmsWorker`: it skips the auth-cache loop
 * entirely rather than scheduling one that can do nothing.
 */
export function createClerkAuthCacheRefresher(
  options: ClerkRefresherOptions,
): (() => Promise<void>) | undefined {
  const { secret, cachePath, useOrganizationsAsGroups } = options
  if (!secret.current()) return undefined

  const refreshWith = async (secretKey: string): Promise<void> => {
    const result = await refreshClerkCache({
      secretKey,
      cachePath,
      useOrganizationsAsGroups,
      // Injected rather than left to default `console.warn`: this runs in the
      // worker, so its Organizations-refused warning needs the ISO-8601
      // prefix like everything else here. canopycms is only a peer dependency
      // of canopycms-auth-clerk, so the join happens at this entrypoint, which
      // already imports both.
      warn: workerLogWarn,
    })
    workerLog(`  ${result.userCount} users, ${result.groupCount} groups`)
  }

  return async () => {
    // Read per call, not captured: an earlier refresh may already have swapped
    // a rotated key in, and capturing the boot-time value is precisely the bug
    // this module exists to fix.
    const key = secret.current()
    if (!key) return

    await withKeyReread(secret, key, WORKER_LOG, refreshWith)
  }
}

export interface ClerkSnapshotFetcherOptions {
  /** The Clerk secret key, re-readable when Clerk rejects it. */
  secret: ReactiveSecret
  /** Whether Clerk Organizations become Canopy groups; see {@link parseClerkOrganizationsAsGroups}. */
  useOrganizationsAsGroups: boolean
  /** Default: the worker's loggers. The gateway passes its own, which scrub. */
  log?: ClerkRefreshLog
}

/**
 * Build the gateway's `authSnapshot` provider, or `undefined` when no Clerk key is configured
 * (the gateway then reports `clerkConfigured: false` and the worker schedules no auth-cache
 * loop). The same gate as {@link createClerkAuthCacheRefresher}, around the fetch alone: the
 * worker writes what it returns.
 */
export function createClerkSnapshotFetcher(
  options: ClerkSnapshotFetcherOptions,
): (() => Promise<AuthCacheSnapshot>) | undefined {
  const { secret, useOrganizationsAsGroups } = options
  const log = options.log ?? WORKER_LOG
  if (!secret.current()) return undefined

  const fetchWith = (secretKey: string): Promise<AuthCacheSnapshot> =>
    fetchClerkSnapshot({ secretKey, useOrganizationsAsGroups, warn: log.warn })

  return async () => {
    // Per call, like the refresher's: the key may have rotated since the last one.
    const key = secret.current()
    if (!key) throw new Error('No Clerk secret key is configured')
    return withKeyReread(secret, key, log, fetchWith)
  }
}
