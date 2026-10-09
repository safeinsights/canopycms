import type { ApiResponse } from '../api/types'
import { BranchProvisioningBusyError } from '../branch-provisioning'
import { RemoteNotReadyError } from '../git-manager'
import type { WorkerStartupFailure } from '../task-queue/worker-status'
import { SchemaUnavailableError } from '../schema/schema-unavailable-error'
import { jsonResponse, type CanopyResponse } from './types'

/** Seconds a client should wait before retrying while the worker boots. */
const RETRY_AFTER_SECONDS = '30'

/**
 * Seconds before retrying an unavailable entry type. The editor's client never resends a 503
 * (api/client.ts resends only a 429), so this informs other clients; the editor tells authors to
 * reload.
 */
const SCHEMA_RETRY_AFTER_SECONDS = '60'

export const WORKER_NOT_READY_MESSAGE =
  'CMS worker not ready — it may still be starting. Try again in a minute; if this persists, ask an admin to check the CMS worker.'

/**
 * An AWS account id, as twelve digits or the console's dddd-dddd-dddd. A secret's ARN in a
 * worker error carries one; the region and names around it are what an admin needs.
 */
const ACCOUNT_ID =
  /(?<![0-9A-Za-z-])[0-9]{4}-[0-9]{4}-[0-9]{4}(?![0-9A-Za-z-])|(?<![0-9A-Za-z])[0-9]{12}(?![0-9A-Za-z])/g

function workerFailureResponse(failure: WorkerStartupFailure): CanopyResponse<ApiResponse> {
  const detail = failure.message.replace(ACCOUNT_ID, (id) => id.replace(/[0-9]/g, '*'))
  if (failure.current) {
    return jsonResponse(
      {
        ok: false,
        status: 503,
        error: `The CMS worker failed to start (${failure.at}): ${detail} An admin needs to fix the worker; retrying will not help until then.`,
        code: 'WORKER_FAILED',
      },
      503,
    )
  }
  return jsonResponse(
    {
      ok: false,
      status: 503,
      error: `CMS worker not ready — it is starting again after a failure (${failure.at}): ${detail} Try again in a minute; if this persists, ask an admin to check the CMS worker.`,
    },
    503,
    { 'Retry-After': RETRY_AFTER_SECONDS },
  )
}

/**
 * The 503 for a request that hit {@link RemoteNotReadyError},
 * {@link BranchProvisioningBusyError} or {@link SchemaUnavailableError}, or `undefined` for any
 * other error. Retriable (with `Retry-After`) unless the worker recorded that its latest start
 * failed, which the body names with account ids masked. The single mapping point for the core handler, the AI route and every framework
 * adapter's backstop, so the message and `Retry-After` cannot diverge.
 */
export function workerNotReadyResponse(err: unknown): CanopyResponse<ApiResponse> | undefined {
  if (err instanceof SchemaUnavailableError) {
    return jsonResponse(
      { ok: false, status: 503, error: err.message, code: 'SCHEMA_UNAVAILABLE' },
      503,
      { 'Retry-After': SCHEMA_RETRY_AFTER_SECONDS },
    )
  }
  if (err instanceof RemoteNotReadyError && err.workerStartupFailure) {
    return workerFailureResponse(err.workerStartupFailure)
  }
  const message =
    err instanceof RemoteNotReadyError
      ? WORKER_NOT_READY_MESSAGE
      : err instanceof BranchProvisioningBusyError
        ? err.message
        : undefined
  if (message === undefined) return undefined
  return jsonResponse({ ok: false, status: 503, error: message }, 503, {
    'Retry-After': RETRY_AFTER_SECONDS,
  })
}
