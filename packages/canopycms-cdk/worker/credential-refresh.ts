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
 * For the Clerk key, at the default intervals, it is inert: the key's only
 * trigger is the auth-cache loop (15 minutes), already slower than this.
 *
 * For the GitHub token it is ACTIVE, and it is what bounds the cost. That token
 * has two triggers in core, a failed task and a failed git sync (see
 * `CmsWorker.refreshGitHubCredential`), and a task retries on a 5s/10s/20s
 * backoff — so a queue of publishes failing on a dead token would otherwise
 * read every few seconds. The floor makes that one read per interval, shared by
 * both triggers. The price of sharing it: a rotation is picked up at the first
 * failure after it that the floor permits, which is immediately unless some
 * failure in the last interval has already used the read, and then at most one
 * interval later. A publish that exhausts its retries inside that wait still
 * fails.
 *
 * It is also a BACKSTOP against loop tuning, because both loop intervals are
 * adopter-configurable. `CANOPYCMS_GIT_SYNC_INTERVAL=10000` against a
 * permanently-broken credential would otherwise mean a `GetSecretValue` every
 * ten seconds for the life of the instance. With the floor, the worst case is
 * twelve `refresh()` attempts an hour per secret, no matter how the loops are
 * tuned or how many tasks fail.
 *
 * That is twelve `GetSecretValue` calls an hour in the normal case, but up to
 * FOUR times that if the SDK call is itself failing: one `refresh()` is one
 * `getSecret`, and `fetchSecretString` retries a TRANSPORT failure up to
 * `retries` times (default 3, so four calls at 1s/2s/4s — see secrets.ts).
 * Forty-eight calls an hour is about 18 cents a month at $0.05 per 10,000, and
 * it needs Secrets Manager itself to be failing continuously for a month.
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
      // Stamped BEFORE the await, not after: stamping after lets two
      // overlapping calls each see an unstamped clock and both issue a read,
      // which is the floor not holding.
      //
      // Overlap is real for the GitHub token: its two triggers, a failed task
      // and a failed git sync, run on separate loops that `scheduleLoop` does
      // not serialise against each other (CmsWorker.refreshGitHubCredential).
      // The Clerk key has one calling loop, which awaits each cycle.
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
