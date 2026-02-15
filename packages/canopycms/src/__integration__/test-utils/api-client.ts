/**
 * API client helper for integration tests.
 * Creates requests and calls the Canopy HTTP handler.
 */

import type { CanopyRequest } from '../../http/types'
import { createCanopyRequestHandler } from '../../http/handler'
import { createTestServices } from '../../config-test'
import type { CreateCanopyServicesOptions } from '../../services'
import type { CanopyConfig, RootCollectionConfig } from '../../config'
import type { AuthPlugin } from '../../auth/plugin'
import { CanopyApiClient } from '../../api/client'

export interface ApiClientOptions {
  config: CanopyConfig
  authPlugin: AuthPlugin
  /** Pre-resolved schema for tests (bypasses .collection.json loading) */
  schema?: RootCollectionConfig
  /** Schema registry for resolving .collection.json references */
  schemaRegistry?: CreateCanopyServicesOptions['schemaRegistry']
}

/**
 * Create an API client that makes requests through the HTTP handler.
 * This simulates real API calls without needing a server.
 *
 * The client wraps the production CanopyApiClient with a custom fetch
 * that routes through the handler directly instead of making network requests.
 */
export async function createApiClient(options: ApiClientOptions) {
  // Use test services with schema
  const services = await createTestServices({
    ...options.config,
    schema: options.schema ?? { collections: [] },
  }, {
    schemaRegistry: options.schemaRegistry,
  })
  const handler = createCanopyRequestHandler({
    services,
    authPlugin: options.authPlugin,
    getBranchContext: async (branchName: string, opts?: { loadSchema?: boolean }) => {
      if (!services.registry) {
        throw new Error('Branch registry not available in dev mode')
      }
      const context = await services.registry.get(branchName)
      if (!context) {
        return null
      }

      // Load per-branch schema if requested
      if (opts?.loadSchema) {
        const contentRootName = services.config.contentRoot || 'content'
        const cached = await services.schemaCacheRegistry.getSchema(
          context.branchRoot,
          services.schemaRegistry,
          contentRootName
        )
        context.schema = cached.schema
        context.flatSchema = cached.flatSchema
      }

      return context
    },
  })

  /**
   * Custom fetch that routes through the handler
   */
  const testFetch: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    // Handle Request objects by extracting URL
    const urlStr = typeof input === 'string'
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url

    const path = urlStr.replace(/^http:\/\/[^/]+/, '') // Strip protocol/host
    const segments = path.replace(/^\/api\/canopycms\/?/, '').split('/').filter(Boolean)

    const req: CanopyRequest = {
      method: init?.method ?? 'GET',
      url: urlStr,
      header: (name: string) => {
        if (!init?.headers) return null
        if (init.headers instanceof Headers) {
          return init.headers.get(name)
        }
        return (init.headers as Record<string, string>)[name.toLowerCase()] ?? null
      },
      json: async () => {
        if (!init?.body) return undefined
        if (typeof init.body === 'string') {
          return JSON.parse(init.body)
        }
        return undefined
      },
    }

    const response = await handler(req, segments)

    // Return a Response-like object
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      json: async () => response.body,
    } as Response
  }

  // Create production client with test fetch
  const client = new CanopyApiClient({
    baseUrl: '/api/canopycms',
    fetch: testFetch,
  })

  /**
   * Legacy request function for backward compatibility
   */
  async function request(
    method: string,
    path: string,
    body?: any,
    headers: Record<string, string> = {}
  ) {
    const response = await testFetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })

    return {
      status: response.status,
      ok: response.ok,
      json: async <T = unknown>() => response.json() as Promise<T>,
      body: await response.json(),
    }
  }

  return {
    // Expose all typed client methods
    ...client,

    // Legacy compatibility: keep old method signatures
    get: (path: string, headers?: Record<string, string>) =>
      request('GET', path, undefined, headers),

    post: (path: string, body?: any, headers?: Record<string, string>) =>
      request('POST', path, body, headers),

    put: (path: string, body?: any, headers?: Record<string, string>) =>
      request('PUT', path, body, headers),

    patch: (path: string, body?: any, headers?: Record<string, string>) =>
      request('PATCH', path, body, headers),

    delete: (path: string, headers?: Record<string, string>) =>
      request('DELETE', path, undefined, headers),

    /**
     * Access to underlying services for setup/teardown
     */
    services,
  }
}

export type ApiClient = ReturnType<typeof createApiClient>
