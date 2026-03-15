import { verifyToken as clerkVerifyToken } from '@clerk/backend'
import { extractHeaders } from 'canopycms/auth'
import type { TokenVerifier } from 'canopycms/auth'

/**
 * Extract token from headers.
 * Looks for Bearer token in Authorization header or __session cookie.
 */
function extractToken(headers: { get(name: string): string | null }): string | null {
  const authHeader = headers.get('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }

  const cookie = headers.get('Cookie')
  if (cookie) {
    const match = cookie.match(/__session=([^;]+)/)
    if (match) {
      return match[1]
    }
  }

  return null
}

export interface ClerkJwtVerifierConfig {
  /**
   * PEM public key for networkless JWT verification.
   * Required for operation without internet access.
   */
  jwtKey: string
  /**
   * Clerk Secret Key as fallback (requires internet).
   * If not provided, only jwtKey verification is attempted.
   */
  secretKey?: string
  /**
   * Authorized parties for CSRF protection.
   */
  authorizedParties?: string[]
}

/**
 * Creates a token verifier function that uses Clerk's JWT verification.
 *
 * When jwtKey (PEM public key) is provided, verification is **networkless** —
 * no Clerk API calls are made. This is used in Lambda environments
 * with no internet access.
 *
 * Returns a TokenVerifier compatible with CachingAuthPlugin.
 */
export function createClerkJwtVerifier(config: ClerkJwtVerifierConfig): TokenVerifier {
  return async (context: unknown) => {
    const headers = extractHeaders(context)
    if (!headers) return null

    const token = extractToken(headers)
    if (!token) return null

    try {
      const verifyOptions: Parameters<typeof clerkVerifyToken>[1] = {}

      if (config.jwtKey) {
        verifyOptions.jwtKey = config.jwtKey
      }
      if (config.secretKey) {
        verifyOptions.secretKey = config.secretKey
      }
      if (config.authorizedParties) {
        verifyOptions.authorizedParties = config.authorizedParties
      }

      const payload = await clerkVerifyToken(token, verifyOptions)

      if (!payload?.sub) return null

      return { userId: payload.sub }
    } catch {
      return null
    }
  }
}
