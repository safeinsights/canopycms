/**
 * Process-scoped logger indirection for modules that run in BOTH the worker
 * daemon and the Lambda/dev server.
 *
 * ## Why this exists
 *
 * `worker/log.ts` documents a hard invariant: every line written to
 * `/var/log/canopy-worker/worker.log` must start with an ISO-8601 timestamp,
 * because the CloudWatch agent's `multi_line_start_pattern` is keyed on that
 * prefix (see `canopycms-cdk/src/constructs/cms-service.ts`). A line WITHOUT
 * the prefix is not a new event - it is appended to the PREVIOUS one,
 * inheriting that event's timestamp and carrying none of its own severity tag.
 *
 * The worker's own code honoured that by calling `workerLog*`. But the worker
 * process also executes shared modules that were never worker-specific and
 * called bare `console.warn`: `github-service.ts` (the throttling plugin's
 * rate-limit callbacks fire on the worker's own Octokit, and the PR
 * create/update path runs on the worker's submit task) and `branch-registry.ts`
 * (registry regeneration, reached from every worker `meta.save()`). Their
 * output landed in worker.log unprefixed, so an operationally interesting
 * warning - "GitHub throttled us" - was silently folded into a minutes-old
 * event and became invisible to `filter @message like /WARN/`. Invisible
 * locally too, since vitest intercepts console.
 *
 * ## Why process-scoped rather than a threaded parameter
 *
 * The invariant is a property of the PROCESS's stdout/stderr, not of any
 * particular call: the same `branch-registry.ts` line is correct as bare
 * console under Lambda and wrong under the worker. Threading a logger down to
 * it would mean touching every signature between `CmsWorker.rebase*` and
 * `BranchMetadataFileManager.loadOnly` to carry a logging concern. One
 * process-wide switch, set once at the worker entrypoint, expresses exactly
 * the thing that is actually true.
 *
 * Lambda and the dev server install nothing and keep plain `console`, which is
 * correct there - CloudWatch's Lambda integration stamps and delimits events
 * on its own.
 *
 * ## Usage
 *
 * Shared server-side modules call `canopyLogWarn`/`canopyLogError`/`canopyLog`
 * instead of `console.*`. The worker entrypoint calls `installWorkerLogger()`
 * (`worker/log.ts`, re-exported from `worker/cms-worker.ts`) once, before doing
 * any work.
 *
 * Not for browser/editor code: those keep `console` directly. This module is
 * dependency-free so importing it can never drag a server-only dependency into
 * a client bundle, but there is nothing for it to do in a browser.
 */

/** The three levels the shared modules use. Structurally satisfied by `console`. */
export interface CanopyLogger {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/**
 * Deliberately mutable module state, read at CALL time by the helpers below
 * rather than captured at import time. Module import order is not something a
 * call site controls, so a captured reference would mean whether a line got its
 * prefix depended on whether `github-service.ts` happened to be imported before
 * or after the entrypoint installed the worker logger.
 */
let active: CanopyLogger = console

/**
 * Route subsequent `canopyLog*` calls through `logger`. Idempotent, and safe to
 * call after the modules that use the helpers have already been imported.
 */
export function setCanopyLogger(logger: CanopyLogger): void {
  active = logger
}

/** Restore the default (`console`). Exists for tests; production installs once and never reverts. */
export function resetCanopyLogger(): void {
  active = console
}

/** The logger currently installed. Exported for assertions; prefer the helpers below. */
export function getCanopyLogger(): CanopyLogger {
  return active
}

/** Informational. Routes to stdout (or the worker's timestamped stdout). */
export function canopyLog(...args: unknown[]): void {
  active.log(...args)
}

/** Recoverable problem - the caller carries on. Routes to stderr. */
export function canopyLogWarn(...args: unknown[]): void {
  active.warn(...args)
}

/** Failure worth alerting on. Routes to stderr. */
export function canopyLogError(...args: unknown[]): void {
  active.error(...args)
}
