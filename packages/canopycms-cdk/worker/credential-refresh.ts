/**
 * Re-reading a Secrets Manager credential that has stopped working.
 *
 * **Reactive, not polled.** A secret is re-read only when the operation using
 * it fails, so a healthy worker makes ZERO `GetSecretValue` calls after boot —
 * which is the whole reason this is not a fourth interval alongside the task,
 * sync and auth-cache loops.
 *
 * The problem it solves: both secrets are read once in `index.ts`'s `main()`,
 * before `new CmsWorker(...)`, and nothing re-read them. A rotated secret
 * therefore never reached a running worker at all — rotation meant waiting for
 * an instance replacement, which happens only on `cdk deploy` or a spot
 * interruption. For the Clerk key the failure was silent on top of that:
 * `CmsWorker.refreshAuthCache()` swallows its errors, so a rotated key produced
 * one log line every fifteen minutes and nothing else.
 *
 * Lives in `canopycms-cdk`, NOT in `canopycms` core, for the same reason
 * `secrets.ts` does: core's `CmsWorker` is documented as "Cloud-agnostic: uses
 * git/Octokit directly, no AWS SDK dependency". An adopter wiring their own
 * worker on another cloud writes their own equivalent of this file and passes
 * it in through the same seams (`refreshAuthCache`, `refreshGitHubToken`);
 * `docs/adopter-migration.md` carries that wiring written out.
 *
 * Split out of `index.ts` so it can be imported by a test at all: `index.ts`
 * ends in `main().catch(...)`, so importing it RUNS the worker.
 */

import { workerLog } from 'canopycms/worker/cms-worker'

import { getSecret, type GetSecretOptions } from './secrets'

/**
 * Floor on how often ONE secret is re-read, in ms.
 *
 * At the worker's default loop intervals this is inert, and that is the
 * intended state: the GitHub credential is refreshed from the git-sync loop
 * (5 minutes) and the Clerk key from the auth-cache loop (15 minutes), so both
 * are already slower than this and nothing is artificially delayed — a
 * rotation is picked up as fast as the worker can possibly notice it.
 *
 * It earns its place as a BACKSTOP, because both of those intervals are
 * adopter-configurable. `CANOPYCMS_GIT_SYNC_INTERVAL=10000` against a
 * permanently-broken credential would otherwise mean a `GetSecretValue` every
 * ten seconds for the life of the instance. With the floor, the worst case is
 * twelve reads an hour per secret — about four cents a month at $0.05 per
 * 10,000 calls — no matter how the loops are tuned.
 *
 * Note what it does NOT throttle: GitHub and Clerk traffic. The loops call
 * those on their own schedule whether or not a refresh happens, and this
 * module adds no request to either.
 */
export const DEFAULT_MIN_SECRET_READ_INTERVAL_MS = 5 * 60_000

export interface ReactiveSecretOptions extends GetSecretOptions {
  /**
   * The secret to re-read. Undefined means there is nothing to re-read —
   * the credential came from a plain environment variable — and `refresh()`
   * then makes no call at all.
   */
  arn?: string
  /**
   * The value already in hand, read at boot. Compared against each re-read to
   * decide whether anything actually rotated.
   */
  initial?: string
  /** See `DEFAULT_MIN_SECRET_READ_INTERVAL_MS`. */
  minIntervalMs?: number
  /**
   * Clock, injectable so tests can advance time instead of waiting five
   * minutes. Defaults to `Date.now`.
   */
  now?: () => number
}

export interface ReactiveSecret {
  /** The value currently held — the boot-time one until something rotates. */
  current: () => string | undefined
  /**
   * Re-read, and resolve to the NEW value — or to `undefined` for "nothing to
   * do", which is every no-op case: no ARN, re-read too recently, or a value
   * identical to the one already held.
   *
   * A caller can therefore treat a returned string as "it changed, the retry
   * you were about to skip is now worth making", with no comparison of its
   * own. A failure to read the secret propagates: the caller is already in a
   * failure path and a malformed or inaccessible secret is worth surfacing.
   */
  refresh: () => Promise<string | undefined>
}

/**
 * A credential that can be re-read on demand, with three guards on the re-read.
 *
 * Each closes a different path to an unbounded stream of `GetSecretValue`
 * calls, and all three are needed — a permanently-wrong secret (revoked, or an
 * operator who pasted the publishable key) must cost a bounded handful of calls
 * and then settle, while a real rotation is still picked up promptly.
 *
 * 1. **Nothing to re-read.** No ARN configured, so the credential came from a
 *    plain env var and no amount of re-reading will change it.
 * 2. **Too soon.** See `DEFAULT_MIN_SECRET_READ_INTERVAL_MS`.
 * 3. **Unchanged.** The re-read matched what we already hold, so nothing
 *    rotated and the caller's retry cannot succeed. Reported as "nothing to
 *    do" rather than as a new value, so the caller skips a guaranteed failure
 *    instead of paying for it. For the Clerk half that second failure is not
 *    cheap: `refreshClerkCache` paginates every user, every organisation, and
 *    a membership fetch per user.
 *
 * `jsonField` and the rest of `GetSecretOptions` are passed straight through,
 * so this handles a plain single-value secret (the default, and what every
 * deployment uses unless it opts in) exactly as it handles one field of a JSON
 * document.
 */
export function createReactiveSecret(options: ReactiveSecretOptions): ReactiveSecret {
  const {
    arn,
    initial,
    minIntervalMs = DEFAULT_MIN_SECRET_READ_INTERVAL_MS,
    now = Date.now,
    ...secretOptions
  } = options

  let value = initial
  // `undefined`, not the boot time: the boot read happened in `main()` and its
  // timestamp is not this module's to assume. The first failure after boot
  // should re-read immediately rather than waiting out an interval measured
  // from an event this object did not observe.
  let lastReadAt: number | undefined

  return {
    current: () => value,
    refresh: async () => {
      if (!arn) return undefined

      const at = now()
      // `>=`, so a minIntervalMs of 0 (a test, or an adopter opting out)
      // permits every call rather than blocking on an identical timestamp.
      if (lastReadAt !== undefined && at - lastReadAt < minIntervalMs) return undefined
      // Stamped BEFORE the await, not after. Stamping after would let two
      // concurrent failures -- the task loop and the sync loop both tripping
      // in the same tick -- each see an unstamped clock and both issue a read.
      lastReadAt = at

      const fetched = await getSecret(arn, secretOptions)
      if (fetched === value) return undefined

      value = fetched
      // No value in the log line, ever: this reaches
      // /var/log/canopy-worker/worker.log, which the CloudWatch agent ships
      // off the instance. The ARN names which secret changed, which is the
      // whole of what an operator needs.
      workerLog(`Secret ${arn} changed since boot — using the new value.`)
      return fetched
    },
  }
}
