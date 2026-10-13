import { isApiTimeoutError, isNonApiResponse, WRITE_TIMED_OUT_MESSAGE } from '../api/client'
import type { ApiResponse } from '../api/types'

/** A write a gateway answered with a 5xx page (how a slow request ends behind CloudFront). */
export class UnansweredError extends Error {
  override readonly name = 'UnansweredError'

  constructor() {
    super(WRITE_TIMED_OUT_MESSAGE)
  }
}

/** Whether a refused response is a gateway's 5xx page rather than the API's answer. */
export function isGatewayFailure(result: ApiResponse): boolean {
  return !result.ok && isNonApiResponse(result) && result.status >= 500
}

/** Whether `err` leaves a write's outcome unknown: a timeout, or a gateway's 5xx page. */
export function isUnanswered(err: unknown): boolean {
  return isApiTimeoutError(err) || err instanceof UnansweredError
}

/**
 * A failed write whose outcome is unknown, so its message is a warning (yellow), not an error
 * (docs/ux-guidelines.md, Loading, empty and error states).
 */
export class MayHaveLandedError extends Error {
  override readonly name = 'MayHaveLandedError'
}
