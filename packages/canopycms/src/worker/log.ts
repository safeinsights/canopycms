/**
 * Timestamp-prefixed logging for the CMS worker daemon.
 *
 * The worker's stdout AND stderr both append to
 * `/var/log/canopy-worker/worker.log` (see the systemd unit written by
 * `packages/canopycms-cdk/src/constructs/cms-service.ts` user-data), which the
 * amazon-cloudwatch-agent tails. That arrangement loses two things a bare
 * `console.log` used to get for free under journald:
 *
 * 1. **A real timestamp.** CloudWatch otherwise stamps events with their
 *    *ingestion* time - when the agent read and shipped the line, not when the
 *    worker emitted it. The skew is small in steady state and largest exactly
 *    when it matters most (agent hiccup, buffered burst, instance restart).
 * 2. **Severity.** Both streams land in one file, so `console.log` and
 *    `console.error` are indistinguishable downstream. The level tag restores
 *    it as a greppable field (`filter @message like /ERROR/`).
 *
 * INVARIANT: every line written to worker.log must start with this ISO-8601
 * timestamp. The agent config sets `multi_line_start_pattern` keyed on that
 * prefix so a stack trace collapses into ONE CloudWatch event instead of
 * fragmenting line-by-line - which also means any line WITHOUT the prefix is
 * appended to the preceding event rather than starting its own. That is why
 * the AWS entrypoint (`packages/canopycms-cdk/worker/index.ts`) imports these
 * helpers too rather than calling `console` directly. Output Node itself
 * prints (an uncaught-exception dump on the way down) is the one uncovered
 * case: it attaches to the previous event, still strictly better than the
 * per-line fragmentation it replaces.
 *
 * The timestamp and level are passed as SEPARATE console arguments rather than
 * concatenated into the message, so console's native formatting of non-string
 * arguments survives - Errors keep their stacks, objects keep their inspection
 * output.
 */

import { setCanopyLogger } from '../utils/logger'

/** ISO-8601 with milliseconds, e.g. `2026-08-12T14:30:00.000Z`. */
function timestamp(): string {
  return new Date().toISOString()
}

/**
 * Named `workerLog*` rather than a bare `log`/`logError`: `CmsWorker` already
 * carries a `private log = cmsTaskQueueLogger` field, and two different things
 * called `log` in one file is a readability trap.
 */

/** Informational worker output. Routes to stdout. */
export function workerLog(...args: unknown[]): void {
  console.log(timestamp(), 'INFO', ...args)
}

/** Recoverable problem - the worker carries on. Routes to stderr. */
export function workerLogWarn(...args: unknown[]): void {
  console.warn(timestamp(), 'WARN', ...args)
}

/** Failure worth alerting on. Routes to stderr. */
export function workerLogError(...args: unknown[]): void {
  console.error(timestamp(), 'ERROR', ...args)
}

/**
 * Point the shared `canopyLog*` helpers (`utils/logger.ts`) at the prefixing
 * functions above, so modules the worker executes but does not own -
 * `github-service.ts`, `branch-registry.ts` - satisfy the INVARIANT documented
 * at the top of this file instead of writing bare, unprefixed lines into
 * worker.log.
 *
 * Call this ONCE, first thing in a worker entrypoint, before any work that
 * could log. Deliberately not a module-level side effect: importing
 * `worker/log.ts` (or anything that re-exports it) must not silently
 * reconfigure logging for a Lambda or dev-server process that merely wants the
 * helpers' types. The eslint override for the two worker directories bans bare
 * `console` there, but it cannot reach the shared modules above - those are
 * legitimately plain `console` under Lambda. This is the half that covers them.
 */
export function installWorkerLogger(): void {
  setCanopyLogger({ log: workerLog, warn: workerLogWarn, error: workerLogError })
}
