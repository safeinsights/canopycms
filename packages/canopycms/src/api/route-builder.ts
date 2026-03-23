/**
 * Declarative API route builder with Zod validation.
 *
 * This module provides a type-safe way to define API routes that:
 * - Validates params and body at runtime with Zod
 * - Runs declarative guards (auth, branch access, schema loading) before handlers
 * - Provides full TypeScript type inference
 * - Makes code generation trivial (no regex parsing needed)
 * - Self-documents the API surface
 */

import type { z } from 'zod'
import type { ApiContext, ApiRequest } from './types'
import { type GuardId, type ComputeGuardContext, executeGuards } from './guards'

/**
 * Cast specification for branded types in mock data.
 * Maps field paths to cast function names.
 *
 * @example
 * { 'collectionPath': 'createLogicalPath', 'items.*.path': 'createPhysicalPath' }
 */
export type MockDataCasts = Record<
  string,
  'createLogicalPath' | 'createPhysicalPath' | 'as ContentId'
>

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
  defaultMockData?: unknown
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
 * Handler function signature with validated params and body (no guards)
 */
export type RouteHandler<
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
 * Guarded handler: receives guard context as first argument.
 * The guard context shape is computed from the declared guards.
 */
export type GuardedRouteHandler<
  TGuards extends readonly GuardId[],
  TParams extends z.ZodType | undefined,
  TBody extends z.ZodType | undefined,
  TResponse,
> = (
  gc: ComputeGuardContext<TGuards>,
  ctx: ApiContext,
  req: ApiRequest,
  ...args: [
    ...(TParams extends z.ZodType ? [params: z.infer<TParams>] : []),
    ...(TBody extends z.ZodType ? [body: z.infer<TBody>] : []),
  ]
) => Promise<TResponse>

// ============================================================================
// Endpoint configuration types
// ============================================================================

/** Base config fields shared by guarded and unguarded endpoints */
interface EndpointConfigBase<
  TParams extends z.ZodType | undefined,
  TBody extends z.ZodType | undefined,
> {
  namespace: string
  name: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  params?: TParams
  body?: TBody
  bodyType?: string
  responseType: string
  response: unknown
  defaultMockData?: unknown
  mockDataCasts?: MockDataCasts
}

/** Config for an endpoint without guards */
interface UnguardedEndpointConfig<
  TParams extends z.ZodType | undefined,
  TBody extends z.ZodType | undefined,
  TResponse,
> extends EndpointConfigBase<TParams, TBody> {
  guards?: undefined
  response: TResponse
  handler: RouteHandler<TParams, TBody, TResponse>
}

/** Config for an endpoint with guards */
interface GuardedEndpointConfig<
  TGuards extends readonly [GuardId, ...GuardId[]],
  TParams extends z.ZodType | undefined,
  TBody extends z.ZodType | undefined,
  TResponse,
> extends EndpointConfigBase<TParams, TBody> {
  guards: TGuards
  response: TResponse
  handler: GuardedRouteHandler<TGuards, TParams, TBody, TResponse>
}

// ============================================================================
// defineEndpoint overloads
// ============================================================================

/** Define an endpoint without guards */
export function defineEndpoint<
  TParams extends z.ZodType | undefined = undefined,
  TBody extends z.ZodType | undefined = undefined,
  TResponse = unknown,
>(
  config: UnguardedEndpointConfig<TParams, TBody, TResponse>,
): RouteDefinition<TParams, TBody, TResponse>

/** Define an endpoint with declarative guards */
export function defineEndpoint<
  TGuards extends readonly [GuardId, ...GuardId[]],
  TParams extends z.ZodType | undefined = undefined,
  TBody extends z.ZodType | undefined = undefined,
  TResponse = unknown,
>(
  config: GuardedEndpointConfig<TGuards, TParams, TBody, TResponse>,
): RouteDefinition<TParams, TBody, TResponse>

/** Implementation — uses `any` for the union of overloaded config types */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineEndpoint(config: any): RouteDefinition<any, any, any> {
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
  const pattern = config.path.split('/').filter(Boolean)

  // Build path function - handles param substitution
  const buildPath = (paramsOrNothing?: Record<string, string>) => {
    if (!config.params) {
      return config.path
    }
    let result = config.path
    const params = paramsOrNothing as Record<string, string>
    for (const [key, value] of Object.entries(params)) {
      result = result.replace(`:${key}`, encodeURIComponent(String(value)))
    }
    return result
  }

  // Validate params and body using Zod
  const validate = (extracted: { params?: Record<string, string>; body?: unknown }) => {
    const result: { ok: true; params?: unknown; body?: unknown } = { ok: true }

    if (config.params) {
      const paramsResult = config.params.safeParse(extracted.params)
      if (!paramsResult.success) {
        return {
          ok: false,
          error: `Invalid params: ${paramsResult.error.message}`,
        }
      }
      result.params = paramsResult.data
    }

    if (config.body) {
      const bodyResult = config.body.safeParse(extracted.body)
      if (!bodyResult.success) {
        return { ok: false, error: `Invalid body: ${bodyResult.error.message}` }
      }
      result.body = bodyResult.data
    }

    return result
  }

  // Wrap handler with guard execution if guards are declared
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handler: RouteHandler<any, any, any>
  if (config.guards && config.guards.length > 0) {
    const guards = config.guards as readonly GuardId[]
    const guardedHandler = config.handler

    handler = async (ctx: ApiContext, req: ApiRequest, ...args: unknown[]) => {
      // Extract params from args (first arg after ctx/req if present)
      const params = (args[0] as Record<string, unknown>) ?? {}
      const guardResult = await executeGuards(guards, ctx, req, params)
      if (!guardResult.ok) {
        return guardResult.response
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
      return (guardedHandler as Function)(guardResult.guardContext, ctx, req, ...args)
    }
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler = config.handler as RouteHandler<any, any, any>
  }

  return {
    method: config.method,
    path: config.path,
    pattern,
    params: config.params,
    body: config.body,
    response: config.response,
    handler,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buildPath: buildPath as any,
    validate,
  }
}

/**
 * Get all registered routes (for code generation)
 */
export function getAllRoutes(): RouteMetadata[] {
  return ROUTE_REGISTRY
}
