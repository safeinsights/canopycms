/**
 * Declarative API route builder with Zod validation.
 *
 * This module provides a type-safe way to define API routes that:
 * - Validates params and body at runtime with Zod
 * - Provides full TypeScript type inference
 * - Makes code generation trivial (no regex parsing needed)
 * - Self-documents the API surface
 */

import type { z } from 'zod'
import type { ApiContext, ApiRequest, ApiResponse } from './types'

/**
 * Cast specification for branded types in mock data.
 * Maps field paths to cast function names.
 *
 * @example
 * { 'collectionPath': 'createLogicalPath', 'items.*.path': 'createPhysicalPath' }
 */
export type MockDataCasts = Record<string, 'createLogicalPath' | 'createPhysicalPath' | 'as ContentId'>

/**
 * Metadata for code generation
 */
export interface RouteMetadata {
  namespace: string
  name: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  paramsSchema?: z.ZodType
  bodySchema?: z.ZodType
  bodyTypeName?: string
  responseTypeName: string
  defaultMockData?: any
  /** Casts to apply to mock data fields for branded types */
  mockDataCasts?: MockDataCasts
}

/**
 * Global registry - generator reads this
 */
export const ROUTE_REGISTRY: RouteMetadata[] = []

/**
 * Route definition created by defineEndpoint.
 * Contains all metadata needed for:
 * - Server-side routing and validation
 * - Client code generation
 * - Type inference
 */
export interface RouteDefinition<
  TParams extends z.ZodType | undefined = undefined,
  TBody extends z.ZodType | undefined = undefined,
  TResponse = unknown
> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string // Template: '/:branch/content/:collection'
  pattern: readonly string[] // For router matching: [':branch', 'content', ':collection']
  params?: TParams
  body?: TBody
  response: TResponse
  handler: RouteHandler<TParams, TBody, TResponse>

  // For client generation - builds the actual URL from arguments
  buildPath: TParams extends z.ZodType
    ? (params: z.infer<TParams>) => string
    : () => string

  // For server: validate and extract params/body
  validate: (extracted: {
    params?: Record<string, string>
    body?: unknown
  }) => {
    ok: true
    params?: TParams extends z.ZodType ? z.infer<TParams> : undefined
    body?: TBody extends z.ZodType ? z.infer<TBody> : undefined
  } | {
    ok: false
    error: string
  }
}

/**
 * Handler function signature with validated params and body
 */
type RouteHandler<
  TParams extends z.ZodType | undefined,
  TBody extends z.ZodType | undefined,
  TResponse
> = (
  ctx: ApiContext,
  req: ApiRequest,
  ...args: [
    ...(TParams extends z.ZodType ? [params: z.infer<TParams>] : []),
    ...(TBody extends z.ZodType ? [body: z.infer<TBody>] : [])
  ]
) => Promise<TResponse>

/**
 * Configuration for defining an endpoint
 */
interface EndpointConfig<
  TParams extends z.ZodType | undefined,
  TBody extends z.ZodType | undefined,
  TResponse
> {
  namespace: string // Client namespace: 'branches', 'workflow', etc.
  name: string // Method name: 'list', 'delete', etc.
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string // e.g., '/:branch' or '/branches' or '/:branch/content/:collection'
  params?: TParams
  body?: TBody
  bodyType?: string // Optional: Type name for body parameter: 'UpdatePermissionsBody'
  responseType: string // Type name for generation: 'BranchDeleteResponse'
  response: TResponse // Type marker for TypeScript
  defaultMockData?: any // Optional: data inside mockSuccess({ ...here })
  mockDataCasts?: MockDataCasts // Optional: casts for branded types in mock data
  handler: RouteHandler<TParams, TBody, TResponse>
}

/**
 * Define an API endpoint with runtime validation and full type inference.
 *
 * @example No params or body (GET list)
 * ```ts
 * const list = defineEndpoint({
 *   namespace: 'branches',
 *   name: 'list',
 *   method: 'GET',
 *   path: '/branches',
 *   responseType: 'BranchListResponse',
 *   response: {} as BranchListResponse,
 *   defaultMockData: { branches: [] },
 *   handler: async (ctx, req) => {
 *     // ...
 *   }
 * })
 * ```
 *
 * @example With params (GET/DELETE single resource)
 * ```ts
 * const deleteBranch = defineEndpoint({
 *   namespace: 'branches',
 *   name: 'delete',
 *   method: 'DELETE',
 *   path: '/:branch',
 *   params: z.object({ branch: z.string() }),
 *   responseType: 'BranchDeleteResponse',
 *   response: {} as BranchDeleteResponse,
 *   defaultMockData: { deleted: true },
 *   handler: async (ctx, req, params) => {
 *     // params.branch is typed as string and VALIDATED!
 *   }
 * })
 * ```
 *
 * @example With body (POST/PUT/PATCH)
 * ```ts
 * const create = defineEndpoint({
 *   namespace: 'branches',
 *   name: 'create',
 *   method: 'POST',
 *   path: '/branches',
 *   body: z.object({
 *     name: z.string(),
 *     baseBranch: z.string().optional()
 *   }),
 *   responseType: 'BranchResponse',
 *   response: {} as BranchResponse,
 *   defaultMockData: { branch: {} },
 *   handler: async (ctx, req, body) => {
 *     // body.name is typed as string and VALIDATED!
 *     // body.baseBranch is typed as string | undefined
 *   }
 * })
 * ```
 *
 * @example With both params and body (PATCH resource)
 * ```ts
 * const updateAccess = defineEndpoint({
 *   namespace: 'branches',
 *   name: 'updateAccess',
 *   method: 'PATCH',
 *   path: '/:branch/access',
 *   params: z.object({ branch: z.string() }),
 *   body: z.object({
 *     allowedUsers: z.array(z.string()).optional()
 *   }),
 *   responseType: 'BranchResponse',
 *   response: {} as BranchResponse,
 *   defaultMockData: { branch: {} },
 *   handler: async (ctx, req, params, body) => {
 *     // params.branch is string (VALIDATED!)
 *     // body.allowedUsers is string[] | undefined (VALIDATED!)
 *   }
 * })
 * ```
 *
 * @example With query parameters (manual validation)
 * ```ts
 * const searchUsers = defineEndpoint({
 *   namespace: 'permissions',
 *   name: 'searchUsers',
 *   method: 'GET',
 *   path: '/permissions/users/search',
 *   responseType: 'SearchUsersResponse',
 *   response: {} as SearchUsersResponse,
 *   defaultMockData: { users: [] },
 *   handler: async (ctx, req) => {
 *     // NOTE: Query parameters currently require manual validation via req.query
 *     // Zod validation for query parameters will be added in a future update
 *     const query = req.query?.q as string | undefined
 *     if (!query) {
 *       return { ok: false, status: 400, error: 'Query parameter "q" is required' }
 *     }
 *     const limitStr = req.query?.limit as string | undefined
 *     const limit = limitStr ? parseInt(limitStr, 10) : undefined
 *     // ... use query and limit
 *   }
 * })
 * ```
 */
export function defineEndpoint<
  TParams extends z.ZodType | undefined = undefined,
  TBody extends z.ZodType | undefined = undefined,
  TResponse = unknown
>(
  config: EndpointConfig<TParams, TBody, TResponse>
): RouteDefinition<TParams, TBody, TResponse> {
  // Register for code generation
  ROUTE_REGISTRY.push({
    namespace: config.namespace,
    name: config.name,
    method: config.method,
    path: config.path,
    paramsSchema: config.params,
    bodySchema: config.body,
    bodyTypeName: config.bodyType,
    responseTypeName: config.responseType,
    defaultMockData: config.defaultMockData,
    mockDataCasts: config.mockDataCasts,
  })

  // Convert path template to pattern array for router
  const pattern = config.path
    .split('/')
    .filter(Boolean) // Remove empty strings from leading/trailing slashes

  // Build path function - handles param substitution
  const buildPath = (paramsOrNothing?: any) => {
    if (!config.params) {
      return config.path
    }

    // Replace :param placeholders with actual values
    let result = config.path
    const params = paramsOrNothing as Record<string, string>
    for (const [key, value] of Object.entries(params)) {
      result = result.replace(`:${key}`, encodeURIComponent(String(value)))
    }
    return result
  }

  // Validate params and body using Zod
  const validate = (extracted: { params?: Record<string, string>; body?: unknown }) => {
    const result: any = { ok: true }

    // Validate params
    if (config.params) {
      const paramsResult = config.params.safeParse(extracted.params)
      if (!paramsResult.success) {
        return { ok: false, error: `Invalid params: ${paramsResult.error.message}` }
      }
      result.params = paramsResult.data
    }

    // Validate body
    if (config.body) {
      const bodyResult = config.body.safeParse(extracted.body)
      if (!bodyResult.success) {
        return { ok: false, error: `Invalid body: ${bodyResult.error.message}` }
      }
      result.body = bodyResult.data
    }

    return result
  }

  return {
    method: config.method,
    path: config.path,
    pattern,
    params: config.params,
    body: config.body,
    response: config.response,
    handler: config.handler as any, // Type assertion needed due to conditional handler signature
    buildPath: buildPath as any, // Type assertion needed for conditional return type
    validate,
  }
}

/**
 * Get all registered routes (for code generation)
 */
export function getAllRoutes(): RouteMetadata[] {
  return ROUTE_REGISTRY
}
