/**
 * Reading a GitHub API failure as the gateway passes it on: an Octokit error in-process, or the
 * wire's `GitHubRequestError`, both carrying `status` and the response headers that classify it.
 */

/** Extract an HTTP status from an error, if present (Octokit RequestError shape). */
export function getHttpStatus(err: unknown): number | null {
  if (err instanceof Error && 'status' in err) {
    const status = (err as { status: unknown }).status
    if (typeof status === 'number') return status
  }
  return null
}

/** Narrow an unknown value to a response-headers record, if present (Octokit lowercases header names). */
function getResponseHeaders(err: unknown): Record<string, unknown> | null {
  if (typeof err !== 'object' || err === null || !('response' in err)) return null
  const response = (err as { response: unknown }).response
  if (typeof response !== 'object' || response === null || !('headers' in response)) return null
  const headers = (response as { headers: unknown }).headers
  if (typeof headers !== 'object' || headers === null) return null
  return headers as Record<string, unknown>
}

/**
 * Whether a 403 is a GitHub rate-limit response rather than a plain permission
 * denial. GitHub signals rate limiting on 403s three ways: the primary limit
 * zeroes `x-ratelimit-remaining`, secondary limits often carry `retry-after`,
 * and both produce a message containing "rate limit".
 */
export function isRateLimitSignal403(err: unknown): boolean {
  const headers = getResponseHeaders(err)
  if (headers) {
    if (headers['x-ratelimit-remaining'] === '0') return true
    if (typeof headers['retry-after'] === 'string' && headers['retry-after'].length > 0) return true
  }
  if (err instanceof Error && /rate limit/i.test(err.message)) return true
  return false
}

/** A 403 that is GitHub denying the credential the operation, not a rate limit. */
export function isPermissionDenial(err: unknown): boolean {
  return getHttpStatus(err) === 403 && !isRateLimitSignal403(err)
}
