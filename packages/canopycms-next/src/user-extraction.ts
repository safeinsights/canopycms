import { headers } from 'next/headers'
import type { CanopyUser, AuthPlugin } from 'canopycms'
import { ANONYMOUS_USER } from 'canopycms'

/**
 * Create a function that extracts user from Next.js server context.
 * Only Next.js-specific code here - everything else is in core.
 */
export function createNextUserExtractor(authPlugin: AuthPlugin) {
  return async (): Promise<CanopyUser> => {
    // Get Next.js headers
    const headersList = await headers()

    // Create minimal request object for auth plugin
    const mockRequest = {
      method: 'GET',
      url: headersList.get('referer') || 'http://localhost',
      header: (name: string) => headersList.get(name),
      json: async () => ({}),
    }

    // Use auth plugin to verify token
    const authResult = await authPlugin.verifyToken(mockRequest)

    if (!authResult.valid || !authResult.user) {
      return ANONYMOUS_USER
    }

    return authResult.user
  }
}
