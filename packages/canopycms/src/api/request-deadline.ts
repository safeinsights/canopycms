/**
 * Deadlines for the editor's API requests. A request that never answers (network drop, laptop
 * sleep) must not hold a busy state open forever, so every client call runs under a deadline and,
 * past it, rejects with {@link ApiTimeoutError}: a thrown error, as a network failure is, but
 * distinguishable from one. HTTP error statuses stay `ok: false` responses.
 */

/**
 * @internal Exported for tests.
 *
 * How long each class of request may take. `standard` is past the 60 s an API behind CloudFront
 * gets (canopycms-cdk's `assertOriginReadTimeout`), so a server still working answers, or its
 * proxy's 504 does, before the editor gives up; reads get it too, since any request may first
 * provision the base branch's workspace (`http/handler.ts`). `long` is
 * for the operations that legitimately run longer: branch create, submit, admin scans and
 * repairs, and an upload without progress.
 */
export const REQUEST_TIMEOUT_MS = {
  standard: 75_000,
  long: 180_000,
} as const

/** An endpoint's timeout class; `none` waits as long as the browser does. */
export type RequestTimeoutClass = keyof typeof REQUEST_TIMEOUT_MS | 'none'

/** Per-call options every API client method accepts as its last argument. */
export interface RequestOptions {
  /** Aborts the request; the call then rejects with the signal's `reason`. */
  signal?: AbortSignal
  /** Replaces the endpoint's timeout, in ms; `null` waits as long as the browser does. */
  timeoutMs?: number | null
}

/** @internal Exported for tests. A timed-out read's message: retrying it is safe. */
export const REQUEST_TIMED_OUT_MESSAGE =
  "The server didn't answer in time. Check your connection and try again."

/** @internal Exported for tests. A timed-out write's message: the server may have acted on it. */
export const WRITE_TIMED_OUT_MESSAGE =
  "The server didn't answer, so this may have gone through anyway. Check before trying again."

/** A request ran past its deadline and was abandoned; the server may still have acted on it. */
export class ApiTimeoutError extends Error {
  override readonly name = 'ApiTimeoutError'

  constructor(
    readonly method: string,
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(method === 'GET' ? REQUEST_TIMED_OUT_MESSAGE : WRITE_TIMED_OUT_MESSAGE)
  }
}

export function isApiTimeoutError(err: unknown): err is ApiTimeoutError {
  return err instanceof ApiTimeoutError
}

/** The timeout, in ms or `null` for none, that a call with `options` to a `timeout`-class endpoint gets. */
export function resolveTimeoutMs(
  timeout: RequestTimeoutClass,
  options: RequestOptions | undefined,
): number | null {
  if (options?.timeoutMs !== undefined) return options.timeoutMs
  return timeout === 'none' ? null : REQUEST_TIMEOUT_MS[timeout]
}

/**
 * Run `run` with a signal that aborts at the deadline or when `options.signal` does, and settle
 * then even if `run` ignores its signal (a custom `fetch` may). Past the deadline the call
 * rejects with an {@link ApiTimeoutError}; on the caller's abort, with the caller's reason.
 */
export async function runWithDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  request: { method: string; path: string; timeoutMs: number | null; signal?: AbortSignal },
): Promise<T> {
  const { signal: callerSignal, timeoutMs } = request
  callerSignal?.throwIfAborted()
  const controller = new AbortController()
  const onCallerAbort = () => controller.abort(callerSignal?.reason)
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  const timer =
    timeoutMs === null
      ? undefined
      : setTimeout(
          () => controller.abort(new ApiTimeoutError(request.method, request.path, timeoutMs)),
          timeoutMs,
        )
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
      once: true,
    })
  })
  try {
    return await Promise.race([run(controller.signal), aborted])
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener('abort', onCallerAbort)
  }
}
