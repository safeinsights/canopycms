import type { CanopyRequest } from '../http/types'

/** The shape Web Headers, Next.js Headers and anything similar share. */
export interface HeadersLike {
  get(name: string): string | null
}

/** A CanopyRequest is recognized by its `header` method plus `method`. */
export function isCanopyRequest(context: unknown): context is CanopyRequest {
  return (
    typeof context === 'object' &&
    context !== null &&
    'header' in context &&
    'method' in context &&
    typeof (context as Record<string, unknown>).header === 'function'
  )
}

/** Headers-like objects are recognized by their `get` method. */
export function isHeadersLike(context: unknown): context is HeadersLike {
  return (
    typeof context === 'object' &&
    context !== null &&
    'get' in context &&
    typeof (context as Record<string, unknown>).get === 'function'
  )
}

/**
 * Headers from either auth context shape -- a CanopyRequest (API routes) or a
 * headers-like object (server components) -- or null for anything else.
 */
export function extractHeaders(context: unknown): HeadersLike | null {
  if (isCanopyRequest(context)) {
    return {
      get: (name: string) => context.header(name),
    }
  }

  if (isHeadersLike(context)) {
    return context
  }

  return null
}

/** Use this in auth plugins: same as extractHeaders, but throws on null. */
export function validateAuthContext(context: unknown): HeadersLike {
  const headers = extractHeaders(context)

  if (!headers) {
    throw new Error(
      'Invalid auth context: expected CanopyRequest or Headers object. ' +
        'Received: ' +
        (context === null ? 'null' : typeof context),
    )
  }

  return headers
}
