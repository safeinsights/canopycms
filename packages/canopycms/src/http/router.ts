import type { ApiResponse } from '../api/types'
import { BRANCH_ROUTES } from '../api/branch'
import { WORKFLOW_ROUTES } from '../api/branch-status'
import { COMMENT_ROUTES } from '../api/comments'
import { CONTENT_ROUTES } from '../api/content'
import { ENTRY_ROUTES } from '../api/entries'
import { ASSET_ROUTES } from '../api/assets'
import { PERMISSION_ROUTES } from '../api/permissions'
import { GROUP_ROUTES } from '../api/groups'
import { USER_ROUTES } from '../api/user'

/**
 * Handler function signature for Canopy API routes.
 * Uses `any` to accommodate different handler signatures in the codebase.
 * Some handlers take (ctx, req, params), others take (ctx, params) directly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CanopyHandler = (...args: any[]) => Promise<ApiResponse<any>>

/**
 * Route definition for the Canopy API.
 * Maps HTTP method + path pattern to a handler.
 */
export interface RouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  pattern: readonly string[] // e.g., [':branch', 'content', ':collection', '...slug']
  handler: CanopyHandler
  // Optional validation function for routes defined with defineEndpoint()
  validate?: (extracted: { params?: Record<string, string>; body?: unknown }) =>
    | {
        ok: true
        params?: any
        body?: any
      }
    | {
        ok: false
        error: string
      }
}

/**
 * Result of route matching.
 */
export interface RouteMatch {
  handler: CanopyHandler
  params: Record<string, string>
  // Optional validation function for new-style routes
  validate?: RouteDefinition['validate']
}

/**
 * Core router - framework-agnostic route matching.
 */
export interface CanopyRouter {
  /** All registered routes */
  readonly routes: RouteDefinition[]

  /** Find a matching route for the given method and path segments */
  match(method: string, segments: string[]): RouteMatch | null
}

/**
 * Build the standard route definitions for the Canopy API.
 * Assembled from co-located route definitions in each API module.
 *
 * This is a function (not a top-level constant) to ensure all route modules
 * have been fully initialized before we try to access their exports.
 * This prevents module initialization timing issues with ES modules.
 */
function buildCanopyRoutes(): RouteDefinition[] {
  return [
    ...Object.values(BRANCH_ROUTES),
    ...Object.values(WORKFLOW_ROUTES),
    ...Object.values(COMMENT_ROUTES),
    ...Object.values(CONTENT_ROUTES),
    ...Object.values(ENTRY_ROUTES),
    ...Object.values(ASSET_ROUTES),
    ...Object.values(PERMISSION_ROUTES),
    ...Object.values(GROUP_ROUTES),
    ...Object.values(USER_ROUTES),
  ].map(
    (route): RouteDefinition => ({
      method: route.method,
      pattern: route.pattern,
      handler: route.handler,
      // Include validation function if present (new-style routes from defineEndpoint)
      validate: 'validate' in route ? (route.validate as any) : undefined,
    }),
  )
}

/**
 * Match a route pattern against actual path segments.
 * Supports :param for single-segment params and ...slug for catch-all.
 */
const matchPattern = (
  pattern: readonly string[],
  actual: string[],
): { params: Record<string, string> } | null => {
  const params: Record<string, string> = {}
  const actualCopy = [...actual]

  for (const part of pattern) {
    // Catch-all: consume remaining segments
    if (part === '...slug') {
      params.slug = actualCopy.join('/')
      actualCopy.length = 0
      break
    }

    const next = actualCopy.shift()
    if (!next) return null

    if (part.startsWith(':')) {
      // Dynamic segment - extract param
      params[part.slice(1)] = decodeURIComponent(next)
    } else if (part !== next) {
      // Static segment - must match exactly
      return null
    }
  }

  // If there are leftover segments, no match
  if (actualCopy.length > 0) return null

  return { params }
}

/**
 * Create the standard Canopy router with all API routes.
 */
export function createCanopyRouter(): CanopyRouter {
  const routes = buildCanopyRoutes()

  return {
    routes,

    match(method: string, segments: string[]): RouteMatch | null {
      const upperMethod = method.toUpperCase()

      for (const route of routes) {
        if (route.method !== upperMethod) continue

        const match = matchPattern(route.pattern, segments)
        if (match) {
          return {
            handler: route.handler,
            params: match.params,
            validate: route.validate, // Include validation function if present
          }
        }
      }

      return null
    },
  }
}
