/**
 * The Clerk auth-cache refresher the EC2 worker hands to `CmsWorker`, with a
 * re-read of the secret key when Clerk rejects the one in hand.
 *
 * **Why the retry is HERE and not in core.** `CmsWorker.refreshAuthCache()`
 * catches and logs everything its callback throws (`cms-worker.ts`, the catch
 * at the end of that method). A retry placed inside core would therefore sit
 * downstream of a `catch` that has already swallowed the failure, and would
 * never see the 401 it is supposed to react to. The callback is the last point
 * where the error is still visible, so the retry lives in the callback. Do not
 * "tidy" this into core without first making `refreshAuthCache()` propagate —
 * see `.claude/future-tasks/refresh-auth-cache-error-handling.md`.
 *
 * Split out of `index.ts` so it can be imported by a test at all: `index.ts`
 * ends in `main().catch(...)`, so importing it RUNS the worker. Same split, and
 * same reason, as `secrets.ts` and `github-app-auth.ts`.
 */

import { workerLog, workerLogWarn, workerLogError } from 'canopycms/worker/cms-worker'
import { refreshClerkCache } from 'canopycms-auth-clerk/cache-writer'
import { getErrorMessage, redactCredentials } from 'canopycms/utils/error'

import type { ReactiveSecret } from './credential-refresh'

/**
 * Does this failure look like Clerk refusing the key, as opposed to Clerk
 * having a bad day?
 *
 * **This gate is the one guard the GitHub half does not need, and the asymmetry
 * is deliberate.** `refreshClerkCache` paginates every user, then every
 * organisation, then does a membership fetch per user — so retrying it on any
 * failure would double that entire workload on every transient 5xx or network
 * blip. The GitHub side has no comparable workload behind its retry (the
 * "retry" there is the task's next attempt or the next scheduled sync), which
 * is why it re-reads unconditionally and this does not.
 *
 * Read STRUCTURALLY off `.status` rather than by `instanceof
 * ClerkAPIResponseError`: `@clerk/backend` is a peer dependency here, so an
 * adopter can resolve a different copy of it than the one this package's tests
 * see, and an `instanceof` across two copies is silently false. The same shape
 * check is used by `isPermanentTaskFailure` and `isTransientAuthFailure` in
 * core for the same reason.
 *
 * `.status` is there to be read, verified against the installed
 * `@clerk/backend@3.17.1`: every API method resolves through
 * `withLegacyRequestReturn` (`dist/index.js:6174-6190`), which on a non-2xx
 * throws `new ClerkAPIResponseError(statusText, { status, ... })` carrying the
 * HTTP status; the class declares `status: number` as a public field
 * (`@clerk/shared`'s `dist/errors/clerkApiResponseError.d.ts`). Note its
 * MESSAGE is `statusText || ''`, so it can be empty — one more reason to
 * classify on the status rather than by matching text.
 *
 * 403 as well as 401: Clerk answers a revoked key with 401, but a key belonging
 * to a different instance, or one whose permissions were narrowed, can come
 * back 403 — and both are "this key will not work, try a different one", which
 * is exactly the condition a rotation fixes.
 */
function isClerkAuthRejection(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('status' in err)) return false
  const status = (err as { status: unknown }).status
  return status === 401 || status === 403
}

export interface ClerkRefresherOptions {
  /** The Clerk secret key, re-readable when Clerk rejects it. */
  secret: ReactiveSecret
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
  const { secret, cachePath } = options
  if (!secret.current()) return undefined

  const refreshWith = async (secretKey: string): Promise<void> => {
    const result = await refreshClerkCache({
      secretKey,
      cachePath,
      useOrganizationsAsGroups: true,
      // Injected rather than left to default `console.warn`: this runs in the
      // worker, so its per-user membership-fetch warning needs the ISO-8601
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

    try {
      await refreshWith(key)
    } catch (err) {
      if (!isClerkAuthRejection(err)) throw err

      // The re-read is best-effort, and its own failure must never REPLACE the
      // Clerk rejection being handled. Without the inner try, an IAM policy
      // narrowed after boot turns every tick into an AccessDeniedException and
      // the 401 that actually explains the stale cache is never logged at all
      // -- and at the DEFAULT 15-minute auth-cache interval that repeats
      // indefinitely, since every tick clears the reader's own 5-minute floor
      // and so re-attempts the read. (Tune `authCacheRefreshInterval` below
      // five minutes and the floor starts absorbing some ticks; the 401 is
      // still lost on the ones that do read.)
      // `CmsWorker.syncGitWithCredentialRefresh` has the same shape for the
      // same reason; this is the Clerk half of it.
      let rotated: string | undefined
      try {
        rotated = await secret.refresh()
      } catch (refreshErr) {
        // [REDACT] `getSecret`'s messages carry key NAMES, never values -- but
        // this line is one edit away from carrying a value, and the rule in
        // this repo is uniform rather than case-by-case. Note it is not
        // sufficient on its own: a Clerk `sk_live_…` matches none of
        // redactCredentials' current rules (see
        // .claude/future-tasks/refresh-auth-cache-error-handling.md).
        workerLogError(
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

      workerLogWarn(
        'Clerk rejected the secret key; the key in Secrets Manager has since changed. Retrying with it.',
      )
      // ONCE. A second rejection is the new key's problem and belongs in the
      // log as a plain failure -- retrying around the re-read would turn a
      // wrong key into a loop over Clerk's entire user list.
      await refreshWith(rotated)
    }
  }
}
