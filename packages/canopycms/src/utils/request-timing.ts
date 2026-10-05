/**
 * Per-request phase timing for the API handler, enabled by `CANOPYCMS_DEBUG=true`.
 *
 * `runWithRequestTiming` opens a request scope in AsyncLocalStorage and, when the request
 * finishes, emits ONE summary line: method, route pattern, status, total, and every phase
 * recorded inside the scope. `timeRequestPhase` records a phase into whichever scope is
 * active. Scopes are per async context, so concurrent requests in one process never share
 * or overwrite a span, and a phase reached outside any request (the worker, a build, a
 * page render) just runs its function.
 *
 * Disabled, `runWithRequestTiming` calls straight through without opening a scope, so each
 * `timeRequestPhase` costs one `getStore()` that returns undefined.
 *
 * A phase started inside another records under the joined name (`route>settingsRoot`), so
 * nesting stays visible and nested time is never added to its parent's siblings. A phase
 * run several times in one request accumulates, and the line shows the count. `untimed` is
 * the total minus the top-level phases, which run sequentially in the handler.
 *
 * Server-only: `node:async_hooks`.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createDebugLogger } from './debug'

interface PhaseTotal {
  count: number
  ms: number
}

interface RequestTimingScope {
  /** Shared by every nested scope of one request; keyed by joined phase name. */
  phases: Map<string, PhaseTotal>
  /** The joined name of the enclosing phase, '' at the request's top level. */
  path: string
  /** Shared by every nested scope; set once the router has matched. */
  request: { route: string }
}

const storage = new AsyncLocalStorage<RequestTimingScope>()
const log = createDebugLogger({ prefix: 'CanopyCMS' })

/** Read per call, like DebugLogger, so toggling the env var needs no restart. */
function isRequestTimingEnabled(): boolean {
  return process.env.CANOPYCMS_DEBUG === 'true'
}

/** Record `fn` as `phase` in the active request scope; outside one, just run it. */
export async function timeRequestPhase<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  const parent = storage.getStore()
  if (!parent) return fn()

  const key = parent.path ? `${parent.path}>${phase}` : phase
  // Created at START so the summary lists phases in the order they began.
  let total = parent.phases.get(key)
  if (!total) {
    total = { count: 0, ms: 0 }
    parent.phases.set(key, total)
  }
  const start = performance.now()
  try {
    return await storage.run({ ...parent, path: key }, fn)
  } finally {
    total.count += 1
    total.ms += performance.now() - start
  }
}

/**
 * Whether a request scope is open here.
 * @internal Exported for tests.
 */
export function isRequestTimingScopeActive(): boolean {
  return storage.getStore() !== undefined
}

/** Name the matched route (a pattern, never raw path segments) for the summary line. */
export function setRequestTimingRoute(route: string): void {
  const scope = storage.getStore()
  if (scope) scope.request.route = route
}

/**
 * The summary line's message, after the logger's timestamp/category prefix:
 * `GET :branch/entries 200 1172ms | context=0 auth=12 route=1110 route>settingsRoot=1080(x2) untimed=50`.
 * @internal Exported for tests.
 */
export function formatRequestTimingSummary(
  method: string,
  route: string,
  status: number | 'error',
  totalMs: number,
  phases: ReadonlyMap<string, PhaseTotal>,
): string {
  let topLevelMs = 0
  const parts: string[] = []
  for (const [name, { count, ms }] of phases) {
    if (!name.includes('>')) topLevelMs += ms
    parts.push(`${name}=${Math.round(ms)}${count > 1 ? `(x${count})` : ''}`)
  }
  parts.push(`untimed=${Math.max(0, Math.round(totalMs - topLevelMs))}`)
  return `${method} ${route} ${status} ${Math.round(totalMs)}ms | ${parts.join(' ')}`
}

/**
 * Run one API request inside a timing scope and log its summary line when it settles,
 * thrown or not. `statusOf` reads the status from the result.
 */
export async function runWithRequestTiming<T>(
  method: string,
  fn: () => Promise<T>,
  statusOf: (result: T) => number,
): Promise<T> {
  if (!isRequestTimingEnabled()) return fn()

  const scope: RequestTimingScope = {
    phases: new Map(),
    path: '',
    request: { route: '(unmatched)' },
  }
  const start = performance.now()
  let status: number | 'error' = 'error'
  try {
    const result = await storage.run(scope, fn)
    status = statusOf(result)
    return result
  } finally {
    log.debug(
      'timing',
      formatRequestTimingSummary(
        method,
        scope.request.route,
        status,
        performance.now() - start,
        scope.phases,
      ),
    )
  }
}
