import type { CanopyRequest } from '../http/types'

/**
 * Headers-like interface for auth context.
 * Framework-agnostic - matches Web Headers, Next.js Headers, and any similar interface.
 */
export interface HeadersLike {
  get(name: string): string | null
}

/**
 * Type guard to check if context is a CanopyRequest.
 * CanopyRequest has both 'header' method and 'method' property.
 */
export function isCanopyRequest(context: unknown): context is CanopyRequest {
  return (
    typeof context === 'object' &&
    context !== null &&
    'header' in context &&
    'method' in context &&
    typeof (context as any).header === 'function'
  )
}

/**
 * Type guard to check if context is a headers-like object.
 * Headers have a 'get' method for retrieving header values.
 */
export function isHeadersLike(context: unknown): context is HeadersLike {
  return (
    typeof context === 'object' &&
    context !== null &&
    'get' in context &&
    typeof (context as any).get === 'function'
  )
}

/**
 * Extract headers from various auth context types.
 * Supports CanopyRequest (API routes) and any headers-like object (server components).
 *
 * @returns HeadersLike object or null if context type is unsupported
 */
export function extractHeaders(context: unknown): HeadersLike | null {
  if (isCanopyRequest(context)) {
    // Wrap CanopyRequest.header() as HeadersLike.get()
    return {
      get: (name: string) => context.header(name),
    }
  }

  if (isHeadersLike(context)) {
    return context
  }

  return null
}

/**
 * Validate auth context and throw helpful error if unsupported.
 * Use this in auth plugins to provide clear error messages.
 */
export function validateAuthContext(context: unknown): HeadersLike {
  const headers = extractHeaders(context)

  if (!headers) {
    throw new Error(
      'Invalid auth context: expected CanopyRequest or Headers object. ' +
        'Received: ' +
        (context === null ? 'null' : typeof context)
    )
  }

  return headers
}
