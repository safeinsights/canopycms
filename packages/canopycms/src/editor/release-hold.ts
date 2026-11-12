/**
 * An admin's release of a branch held as its record of conflicts was set aside
 * (api/merge-conflicts.ts `releaseHold`). An unanswered request is settled by reading the record
 * again, as the release may have landed.
 */

import type { ApiClient } from './context'
import type { ReleaseOutcome } from './components/ReleaseHoldButton'
import { isGatewayFailure, isUnanswered } from './unanswered'
import { getErrorMessage } from '../utils/error'

/** A release's outcome, and on release whether the branch was still held. */
export type ReleaseResult = ReleaseOutcome & { wasHeld?: boolean }

const UNKNOWN: ReleaseResult = {
  error: "Couldn't tell whether the hold was released. Try again in a moment.",
  tone: 'warning',
}

export async function releaseConflictsHold(
  apiClient: Pick<ApiClient, 'conflicts'>,
  branch: string,
): Promise<ReleaseResult> {
  const settle = async (): Promise<ReleaseResult> => {
    const now = await apiClient.conflicts.list({ branch }).catch(() => undefined)
    return now?.ok && now.data && !now.data.held ? { released: true, wasHeld: true } : UNKNOWN
  }
  let result: Awaited<ReturnType<ApiClient['conflicts']['releaseHold']>>
  try {
    result = await apiClient.conflicts.releaseHold({ branch })
  } catch (err) {
    return isUnanswered(err) ? settle() : { error: getErrorMessage(err), tone: 'error' }
  }
  if (result.ok) return { released: true, wasHeld: result.data?.released !== false }
  if (isGatewayFailure(result)) return settle()
  return {
    error: result.error ?? "Couldn't release the hold. Try again in a moment.",
    tone: result.status === 409 ? 'warning' : 'error',
  }
}
