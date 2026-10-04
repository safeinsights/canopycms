/**
 * Timestamp-prefixed logging for the CMS worker daemon.
 *
 * INVARIANT: every line written to worker.log starts with this ISO-8601
 * timestamp and a level tag. The worker's stdout AND stderr both append to
 * `/var/log/canopy-worker/worker.log` (the systemd unit written by
 * `packages/canopycms-cdk/src/constructs/cms-service.ts` user-data), so the
 * level tag is the only thing separating `console.log` from `console.error`
 * downstream; and the amazon-cloudwatch-agent that tails it keys
 * `multi_line_start_pattern` on the timestamp, so a stack trace collapses into
 * ONE event while any UNPREFIXED line is appended to the preceding event
 * instead of starting its own. CloudWatch's own stamp is INGESTION time, which
 * skews most exactly when it matters (agent hiccup, buffered burst, restart).
 *
 * Hence the AWS entrypoint (`packages/canopycms-cdk/worker/index.ts`) imports
 * these helpers rather than calling `console`. Node's own uncaught-exception
 * dump on the way down is the one uncovered case.
 *
 * The timestamp and level are SEPARATE console arguments, never concatenated
 * into the message, so console's native formatting of non-string arguments
 * survives - Errors keep their stacks.
 */

import { setCanopyLogger } from '../utils/logger'

/** ISO-8601 with milliseconds: `YYYY-MM-DDTHH:mm:ss.sssZ`. */
function timestamp(): string {
  return new Date().toISOString()
}

/** Named `workerLog*`, not `log`: `CmsWorker` already carries a `log` field. */

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
 * `github-service.ts`, `branch-registry.ts` - satisfy the INVARIANT above
 * instead of writing bare lines into worker.log. The eslint ban on bare
 * `console` covers the two worker directories but cannot reach those shared
 * modules, which are legitimately plain `console` under Lambda.
 *
 * Call this ONCE, first thing in a worker entrypoint, before any work that
 * could log. Deliberately not a module-level side effect: importing this module
 * must not reconfigure logging for a Lambda or dev-server process that merely
 * wants the helpers' types.
 */
export function installWorkerLogger(): void {
  setCanopyLogger({ log: workerLog, warn: workerLogWarn, error: workerLogError })
}
