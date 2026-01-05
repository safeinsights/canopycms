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
 * Metadata for code generation
 */
export interface RouteMetadata {
  namespace: string
  name: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  paramsSchema?: z.ZodType
  bodySchema?: z.ZodType
  responseTypeName: string
  defaultMockData?: any
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
  TResponse = unknown,
> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string // Template: '/:branch/content/:collection'
  pattern: readonly string[] // For router matching: [':branch', 'content', ':collection']
  params?: TParams
  body?: TBody
  response: TResponse
  handler: RouteHandler<TParams, TBody, TResponse>

  // For client generation - builds the actual URL from arguments
  buildPath: TParams extends z.ZodType ? (params: z.infer<TParams>) => string : () => string

  // For server: validate and extract params/body
  validate: (extracted: { params?: Record<string, string>; body?: unknown }) =>
    | {
        ok: true
        params?: TParams extends z.ZodType ? z.infer<TParams> : undefined
        body?: TBody extends z.ZodType ? z.infer<TBody> : undefined
      }
    | {
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
  TResponse,
> = (
  ctx: ApiContext,
  req: ApiRequest,
  ...args: [
    ...(TParams extends z.ZodType ? [params: z.infer<TParams>] : []),
    ...(TBody extends z.ZodType ? [body: z.infer<TBody>] : []),
  ]
) => Promise<TResponse>

/**
 * Configuration for defining an endpoint
 */
interface EndpointConfig<
  TParams extends z.ZodType | undefined,
  TBody extends z.ZodType | undefined,
  TResponse,
> {
  namespace: string // Client namespace: 'branches', 'workflow', etc.
  name: string // Method name: 'list', 'delete', etc.
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string // e.g., '/:branch' or '/branches' or '/:branch/content/:collection'
  params?: TParams
  body?: TBody
  responseType: string // Type name for generation: 'BranchDeleteResponse'
  response: TResponse // Type marker for TypeScript
  defaultMockData?: any // Optional: data inside mockSuccess({ ...here })
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
 */
export function defineEndpoint<
  TParams extends z.ZodType | undefined = undefined,
  TBody extends z.ZodType | undefined = undefined,
  TResponse = unknown,
>(config: EndpointConfig<TParams, TBody, TResponse>): RouteDefinition<TParams, TBody, TResponse> {
  // Register for code generation
  ROUTE_REGISTRY.push({
    namespace: config.namespace,
    name: config.name,
    method: config.method,
    path: config.path,
    paramsSchema: config.params,
    bodySchema: config.body,
    responseTypeName: config.responseType,
    defaultMockData: config.defaultMockData,
  })

  // Convert path template to pattern array for router
  const pattern = config.path.split('/').filter(Boolean) // Remove empty strings from leading/trailing slashes

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
