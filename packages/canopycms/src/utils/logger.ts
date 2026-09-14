/**
 * Process-scoped logger indirection for modules that run in BOTH the worker daemon and the
 * Lambda/dev server.
 *
 * `worker/log.ts` holds the invariant: every line written to `/var/log/canopy-worker/worker.log`
 * must start with an ISO-8601 timestamp, because the CloudWatch agent's `multi_line_start_pattern`
 * is keyed on that prefix (see `canopycms-cdk/src/constructs/cms-service.ts`). A line WITHOUT the
 * prefix is not a new event - it is appended to the PREVIOUS one, inheriting that timestamp and
 * carrying none of its own severity tag, so an operationally interesting warning goes invisible to
 * `filter @message like /WARN/` (and locally too, since vitest intercepts console). Shared modules
 * the worker also executes (`github-service.ts`, `branch-registry.ts`) would otherwise emit bare
 * `console.warn` into that log.
 *
 * Process-scoped rather than a threaded parameter because the invariant belongs to the PROCESS's
 * stdout/stderr, not to any particular call: the same `branch-registry.ts` line is correct as bare
 * console under Lambda and wrong under the worker. Lambda and the dev server install nothing and
 * keep plain `console`, which is correct there - CloudWatch's Lambda integration stamps and
 * delimits events on its own.
 *
 * So shared server-side modules call `canopyLogWarn`/`canopyLogError`/`canopyLog`, and the worker
 * entrypoint calls `installWorkerLogger()` (`worker/log.ts`, re-exported from
 * `worker/cms-worker.ts`) once before doing any work. Not for browser/editor code, which keeps
 * `console`. Dependency-free, so importing it can never drag a server-only dependency into a
 * client bundle.
 */

/** The three levels the shared modules use. Structurally satisfied by `console`. */
export interface CanopyLogger {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/**
 * Deliberately mutable module state, read at CALL time rather than captured at import time. A call
 * site does not control module import order, so a captured reference would make a line's prefix
 * depend on whether its module was imported before or after the worker logger was installed.
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
