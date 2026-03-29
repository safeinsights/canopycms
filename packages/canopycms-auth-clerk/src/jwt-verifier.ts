import { verifyToken as clerkVerifyToken } from '@clerk/backend'
import { extractHeaders } from 'canopycms/auth'
import type { TokenVerifier } from 'canopycms/auth'
import { extractToken } from './clerk-plugin'

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
 *
 * @deprecated Use `ClerkAuthPlugin.verifyTokenOnly()` instead. The plugin's method is
 * automatically wired into CachingAuthPlugin by `createNextCanopyContext()` in prod/dev.
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
