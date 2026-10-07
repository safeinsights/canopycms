import type { ApiResponse } from '../api/types'
import { RemoteNotReadyError } from '../git-manager'
import { jsonResponse, type CanopyResponse } from './types'

/** Seconds a client should wait before retrying while the worker boots. */
const RETRY_AFTER_SECONDS = '30'

export const WORKER_NOT_READY_MESSAGE =
  'CMS worker not ready — it may still be starting. Try again in a minute; if this persists, ask an admin to check the CMS worker.'

/**
 * The 503 for a request that hit {@link RemoteNotReadyError}, or `undefined`
 * for any other error. The single mapping point for the core handler, the AI route and
 * every framework adapter's backstop, so the message and `Retry-After` cannot diverge.
 */
export function workerNotReadyResponse(err: unknown): CanopyResponse<ApiResponse> | undefined {
  if (!(err instanceof RemoteNotReadyError)) return undefined
  return jsonResponse({ ok: false, status: 503, error: WORKER_NOT_READY_MESSAGE }, 503, {
    'Retry-After': RETRY_AFTER_SECONDS,
  })
}
