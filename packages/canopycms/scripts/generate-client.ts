#!/usr/bin/env tsx
/**
 * Generate typed API client methods from route registry.
 *
 * This script reads route metadata from ROUTE_REGISTRY (populated by defineEndpoint() calls)
 * and generates client method implementations with explicit TypeScript types.
 *
 * NO REGEX PARSING! All metadata comes from route definitions.
 *
 * Usage:
 *   npm run generate:client
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const API_DIR = path.join(__dirname, '../src/api')
const CLIENT_FILE = path.join(API_DIR, 'client.ts')
const MOCK_CLIENT_FILE = path.join(API_DIR, '__test__/mock-client.ts')

// Import all API modules to populate ROUTE_REGISTRY
// These imports execute the defineEndpoint() calls
import '../src/api/branch.js'
import '../src/api/branch-status.js'
import '../src/api/comments.js'
import '../src/api/content.js'
import '../src/api/reference-options.js'
import '../src/api/resolve-references.js'
import '../src/api/entries.js'
import '../src/api/assets.js'
import '../src/api/permissions.js'
import '../src/api/groups.js'
import '../src/api/user.js'

// Now we can import the populated registry
import { getAllRoutes, type RouteMetadata } from '../src/api/route-builder.js'

interface NamespaceRoutes {
  namespace: string
  routes: RouteMetadata[]
}

/**
 * Group routes by namespace
 */
function groupRoutesByNamespace(routes: RouteMetadata[]): NamespaceRoutes[] {
  const byNamespace = new Map<string, RouteMetadata[]>()

  for (const route of routes) {
    const existing = byNamespace.get(route.namespace) || []
    existing.push(route)
    byNamespace.set(route.namespace, existing)
  }

  return Array.from(byNamespace.entries()).map(([namespace, routes]) => ({
    namespace,
    routes,
  }))
}

/**
 * Generate a single client method
 */
function generateClientMethod(route: RouteMetadata): string {
  const hasParams = !!route.paramsSchema
  const hasBody = !!route.bodySchema

  let paramType = ''
  let bodyType = ''

  if (hasParams) {
    paramType = 'params: Record<string, string>'
  }

  if (hasBody) {
    bodyType = 'body: unknown'
  }

  const args = [paramType, bodyType].filter(Boolean).join(', ')

  // Determine the request call
  let requestCall = ''
  if (hasParams && hasBody) {
    requestCall = `this.request('${route.method}', this.buildPath('${route.path}', params), body)`
  } else if (hasParams) {
    requestCall = `this.request('${route.method}', this.buildPath('${route.path}', params))`
  } else if (hasBody) {
    requestCall = `this.request('${route.method}', '${route.path}', body)`
  } else {
    requestCall = `this.request('${route.method}', '${route.path}')`
  }

  return `    /**
     * ${route.name} - ${route.method} ${route.path}
     */
    ${route.name}: (${args}): Promise<${route.responseTypeName}> => {
      return ${requestCall}
    }`
}

/**
 * Generate a client namespace
 */
function generateNamespace(ns: NamespaceRoutes): string {
  const methods = ns.routes.map(route => generateClientMethod(route)).join(',\n\n')

  return `  /**
   * ${ns.namespace} - Auto-generated methods
   */
  readonly ${ns.namespace} = {
${methods},
  }`
}

/**
 * Get unique response types from all routes
 */
function getUniqueResponseTypes(namespaces: NamespaceRoutes[]): Set<string> {
  const types = new Set<string>()
  for (const ns of namespaces) {
    for (const route of ns.routes) {
      types.add(route.responseTypeName)
    }
  }
  return types
}

/**
 * Map namespace to source file for imports
 */
function namespaceToModule(namespace: string): string {
  const mapping: Record<string, string> = {
    'branches': 'branch',
    'workflow': 'branch-status',
    'comments': 'comments',
    'content': 'content',
    'resolveReferences': 'resolve-references',
    'referenceOptions': 'reference-options',
    'entries': 'entries',
    'assets': 'assets',
    'permissions': 'permissions',
    'groups': 'groups',
  }
  return mapping[namespace] || namespace
}

/**
 * Map specific type names to their module location (for exceptions)
 */
function typeNameToModule(typeName: string): string | null {
  const mapping: Record<string, string> = {
    'ResolveReferencesResponse': 'resolve-references',
    'ReferenceOptionsResponse': 'reference-options',
  }
  return mapping[typeName] || null
}

/**
 * Generate import statements for response types grouped by module
 */
function generateResponseTypeImports(namespaces: NamespaceRoutes[]): string {
  const typesByModule = new Map<string, Set<string>>()
  const seenTypes = new Set<string>() // Track which types we've already assigned to a module

  for (const ns of namespaces) {
    const moduleName = namespaceToModule(ns.namespace)
    if (!typesByModule.has(moduleName)) {
      typesByModule.set(moduleName, new Set())
    }
    const types = typesByModule.get(moduleName)!
    for (const route of ns.routes) {
      const typeName = route.responseTypeName
      // Skip ApiResponse (it's in types.ts, not a module-specific type)
      if (typeName === 'ApiResponse') continue

      // Check for specific type name overrides first
      const overrideModule = typeNameToModule(typeName)
      const targetModule = overrideModule || moduleName

      // Only add to first module that uses it (avoid duplicates across modules)
      if (!seenTypes.has(typeName)) {
        if (!typesByModule.has(targetModule)) {
          typesByModule.set(targetModule, new Set())
        }
        typesByModule.get(targetModule)!.add(typeName)
        seenTypes.add(typeName)
      }
    }
  }

  const imports: string[] = []
  for (const [moduleName, types] of typesByModule.entries()) {
    if (types.size === 0) continue // Skip modules with no types
    const sortedTypes = Array.from(types).sort().join(', ')
    imports.push(`import type { ${sortedTypes} } from './${moduleName}'`)
  }

  // Special imports for body types
  imports.push(`import type { CreateBranchBody, UpdateBranchAccessBody } from './branch'`)

  return imports.join('\n')
}

/**
 * Generate the complete client code
 */
function generateClientCode(namespaces: NamespaceRoutes[]): string {
  const namespacesCode = namespaces.map(ns => generateNamespace(ns)).join('\n\n')

  // Generate imports grouped by module
  const responseTypeImports = generateResponseTypeImports(namespaces)

  return `/**
 * Typed API client for CanopyCMS.
 *
 * AUTO-GENERATED by scripts/generate-client.ts
 * Do not edit this file manually - changes will be overwritten.
 */

// Type imports
${responseTypeImports}

/**
 * Options for creating an ApiClient
 */
export interface ApiClientOptions {
  /**
   * Base URL for API requests. Defaults to '/api/canopycms'
   */
  baseUrl?: string

  /**
   * Custom fetch implementation (useful for testing)
   */
  fetch?: typeof fetch
}

/**
 * Lightweight typed API client for CanopyCMS.
 *
 * Provides type-safe methods for all API endpoints with centralized
 * response unwrapping and error handling.
 *
 * @example Browser usage
 * \`\`\`ts
 * const client = createApiClient()
 * const branches = await client.branches.list()
 * if (branches.ok) {
 *   console.log(branches.data.branches)
 * }
 * \`\`\`
 *
 * @example Test usage
 * \`\`\`ts
 * const client = createApiClient({
 *   fetch: mockFetch
 * })
 * \`\`\`
 */
export class CanopyApiClient {
  private baseUrl: string
  private fetchFn: typeof fetch

  // ========== Auto-Generated Client Namespaces ==========
  // Generated by scripts/generate-client.ts - DO NOT EDIT MANUALLY

${namespacesCode}

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '/api/canopycms'
    // Bind fetch to window to prevent "Illegal invocation" errors in browsers
    // In Node.js tests, window is undefined so use fetch directly
    this.fetchFn = options.fetch ?? (typeof window !== 'undefined' ? fetch.bind(window) : fetch)
  }

  // ========== Low-level HTTP methods ==========

  private buildPath(template: string, params: Record<string, string>): string {
    let result = template
    const queryParams: Record<string, string> = {}

    for (const [key, value] of Object.entries(params)) {
      // Check if this param is in the path template
      const pathParamPattern = \`:$\{key}\`
      const restParamPattern = \`...$\{key}\`

      if (result.includes(pathParamPattern)) {
        result = result.replace(pathParamPattern, encodeURIComponent(String(value)))
      } else if (result.includes(restParamPattern)) {
        // For rest parameters, encode each segment separately to preserve slashes
        const encoded = String(value).split('/').map(segment => encodeURIComponent(segment)).join('/')
        result = result.replace(restParamPattern, encoded)
      } else {
        // Not in path template, so it's a query param
        queryParams[key] = value
      }
    }

    // Append query params if any
    if (Object.keys(queryParams).length > 0) {
      const queryString = Object.entries(queryParams)
        .map(([key, value]) => {
          // URL-encode with proper handling of spaces and special chars
          return \`$\{encodeURIComponent(key)}=$\{encodeURIComponent(String(value)).replace(/%20/g, '+')}\`
        })
        .join('&')
      result = \`$\{result}?$\{queryString}\`
    }

    return result
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<T> {
    const url = \`\${this.baseUrl}\${path}\`

    const requestHeaders: Record<string, string> = {
      ...headers,
    }

    if (body !== undefined && !(body instanceof FormData)) {
      requestHeaders['Content-Type'] = 'application/json'
    }

    const init: RequestInit = {
      method,
      headers: requestHeaders,
    }

    if (body !== undefined) {
      if (body instanceof FormData) {
        // Don't set Content-Type for FormData - browser will set it with boundary
        init.body = body
      } else {
        init.body = JSON.stringify(body)
      }
    }

    const response = await this.fetchFn(url, init)
    const payload = await response.json()

    // All responses use ApiResponse format: { ok, status, data?, error? }
    return payload as T
  }
}

/**
 * Create a new API client instance
 */
export function createApiClient(options?: ApiClientOptions): CanopyApiClient {
  return new CanopyApiClient(options)
}
`
}

/**
 * Generate mock client code
 */
function generateMockClientCode(namespaces: NamespaceRoutes[]): string {
  // Generate mock namespaces
  const mockNamespaces = namespaces.map(ns => {
    const methods = ns.routes.map(route => {
      const mockData = route.defaultMockData ? JSON.stringify(route.defaultMockData) : '{}'
      return `    ${route.name}: vi.fn().mockResolvedValue(mockSuccess(${mockData})),`
    }).join('\n')

    return `  ${ns.namespace}: {
${methods}
  },`
  }).join('\n\n')

  // Get unique response types for factories
  const factoryResponseTypes = getUniqueResponseTypes(namespaces)

  // Generate response factories
  const factories = Array.from(factoryResponseTypes).map(responseType => {
    const funcName = `mock${responseType.replace(/Response$/, '')}Response`

    // Find the first route with this response type to get default mock data
    let mockData = '{}'
    for (const ns of namespaces) {
      const route = ns.routes.find(r => r.responseTypeName === responseType)
      if (route?.defaultMockData) {
        mockData = JSON.stringify(route.defaultMockData)
        break
      }
    }

    return `/**
 * Create a ${responseType} for testing
 */
export function ${funcName}(): ${responseType} {
  return mockSuccess(${mockData})
}`
  }).join('\n\n')

  // Generate imports grouped by module
  const responseTypeImports = generateResponseTypeImports(namespaces)
    .split('\n')
    .map(line => line.replace(/^import type/, 'import type').replace(/from '\.\//g, "from '../"))
    .join('\n')

  return `/**
 * Mock API client for testing hooks and components.
 *
 * AUTO-GENERATED by scripts/generate-client.ts
 * Do not edit this file manually - changes will be overwritten.
 */

import { vi, type Mock } from 'vitest'
import type { CanopyApiClient } from '../client'
import type { ApiResponse } from '../types'
${responseTypeImports}

/**
 * Type utility to convert CanopyApiClient methods to Vitest mocks.
 */
export type MockApiClient = {
  [K in keyof CanopyApiClient]: CanopyApiClient[K] extends Record<string, any>
    ? {
        [M in keyof CanopyApiClient[K]]: CanopyApiClient[K][M] extends (...args: infer Args) => infer Return
          ? Mock<Args, Return>
          : never
      }
    : never
}

/**
 * Create a mock API client with all methods as vi.fn().
 */
export function createMockApiClient(): MockApiClient {
  return {
${mockNamespaces}
  } as MockApiClient
}

// ========== Response Helpers ==========

/**
 * Create a successful API response
 */
export function mockSuccess<T>(data: T): ApiResponse<T> {
  return { ok: true, status: 200, data }
}

/**
 * Create an error API response
 */
export function mockError(status: number, error: string): ApiResponse<never> {
  return { ok: false, status, error }
}

/**
 * Create a 404 not found response
 */
export function mockNotFound(): ApiResponse<never> {
  return mockError(404, 'Not found')
}

/**
 * Create a 403 forbidden response
 */
export function mockForbidden(): ApiResponse<never> {
  return mockError(403, 'Forbidden')
}

// ========== Auto-Generated Response Factories ==========
// Generated by scripts/generate-client.ts - DO NOT EDIT MANUALLY

${factories}
`
}

/**
 * Main generation function
 */
async function main() {
  console.log('🔧 Generating API client from route registry...\n')

  // Get all routes from registry
  const allRoutes = getAllRoutes()

  if (allRoutes.length === 0) {
    console.error('❌ No routes found in ROUTE_REGISTRY')
    console.error('   Make sure API modules are using defineEndpoint()')
    process.exit(1)
  }

  // Group by namespace
  const namespaces = groupRoutesByNamespace(allRoutes)

  console.log('Found routes:')
  for (const ns of namespaces) {
    console.log(`  ${ns.namespace}: ${ns.routes.length} routes`)
  }

  console.log(`\n📝 Generating client code for ${namespaces.length} namespaces...\n`)

  // Generate the real client code
  const clientCode = generateClientCode(namespaces)
  await fs.writeFile(CLIENT_FILE, clientCode, 'utf-8')
  console.log(`✅ Successfully generated client.ts`)

  // Generate the mock client code
  const mockClientCode = generateMockClientCode(namespaces)
  await fs.writeFile(MOCK_CLIENT_FILE, mockClientCode, 'utf-8')
  console.log(`✅ Successfully generated mock-client.ts`)

  console.log(`\n   ${allRoutes.length} total methods across ${namespaces.length} namespaces\n`)
  console.log('💡 Next: Run type checking with npm run typecheck\n')
}

main().catch(err => {
  console.error('❌ Generation failed:', err)
  process.exit(1)
})
