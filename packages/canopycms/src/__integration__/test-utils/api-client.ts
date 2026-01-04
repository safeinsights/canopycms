/**
 * API client helper for integration tests.
 * Creates requests and calls the Canopy HTTP handler.
 */

import type { CanopyRequest } from '../../http/types'
import { createCanopyRequestHandler } from '../../http/handler'
import { createCanopyServices } from '../../services'
import type { CanopyConfig } from '../../config'
import type { AuthPlugin } from '../../auth/plugin'

export interface ApiClientOptions {
  config: CanopyConfig
  authPlugin: AuthPlugin
}

/**
 * Create an API client that makes requests through the HTTP handler.
 * This simulates real API calls without needing a server.
 */
export function createApiClient(options: ApiClientOptions) {
  const services = createCanopyServices(options.config)
  const handler = createCanopyRequestHandler({
    services,
    authPlugin: options.authPlugin,
    getBranchContext: async (branchName: string) => {
      const context = await services.registry.get(branchName)
      return context ?? null
    },
  })

  /**
   * Make an API request
   * Returns a fetch-like response object with json() method for consistency with tests
   */
  async function request(
    method: string,
    path: string,
    body?: any,
    headers: Record<string, string> = {},
  ) {
    // Parse path to extract route segments
    // Expected format: /api/canopycms/...
    const url = `http://localhost:3000${path}`
    const segments = path
      .replace(/^\/api\/canopycms\/?/, '')
      .split('/')
      .filter(Boolean)

    const req: CanopyRequest = {
      method,
      url,
      header: (name: string) => headers[name.toLowerCase()] ?? null,
      json: async () => body,
    }

    const response = await handler(req, segments)

    // Return a fetch-like object for easier testing
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      json: async <T = unknown>() => response.body as T,
      body: response.body,
    }
  }

  return {
    /**
     * GET request
     */
    get: (path: string, headers?: Record<string, string>) =>
      request('GET', path, undefined, headers),

    /**
     * POST request
     */
    post: (path: string, body?: any, headers?: Record<string, string>) =>
      request('POST', path, body, headers),

    /**
     * PUT request
     */
    put: (path: string, body?: any, headers?: Record<string, string>) =>
      request('PUT', path, body, headers),

    /**
     * PATCH request
     */
    patch: (path: string, body?: any, headers?: Record<string, string>) =>
      request('PATCH', path, body, headers),

    /**
     * DELETE request
     */
    delete: (path: string, headers?: Record<string, string>) =>
      request('DELETE', path, undefined, headers),

    /**
     * Access to underlying services for setup/teardown
     */
    services,
  }
}

export type ApiClient = ReturnType<typeof createApiClient>
