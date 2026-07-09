import type { ApiResponse } from '../api/types'
import { BRANCH_ROUTES } from '../api/branch'
import { WORKFLOW_ROUTES } from '../api/branch-status'
import { COMMENT_ROUTES } from '../api/comments'
import { CONTENT_ROUTES } from '../api/content'
import { REFERENCE_OPTIONS_ROUTES } from '../api/reference-options'
import { RESOLVE_REFERENCES_ROUTES } from '../api/resolve-references'
import { ENTRY_ROUTES } from '../api/entries'
import { ASSET_ROUTES } from '../api/assets'
import { PERMISSION_ROUTES } from '../api/permissions'
import { GROUP_ROUTES } from '../api/groups'
import { USER_ROUTES } from '../api/user'
import { SCHEMA_ROUTES } from '../api/schema'

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
        params?: unknown
        body?: unknown
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
    ...Object.values(REFERENCE_OPTIONS_ROUTES),
    ...Object.values(RESOLVE_REFERENCES_ROUTES),
    ...Object.values(ENTRY_ROUTES),
    ...Object.values(ASSET_ROUTES),
    ...Object.values(PERMISSION_ROUTES),
    ...Object.values(GROUP_ROUTES),
    ...Object.values(USER_ROUTES),
    ...Object.values(SCHEMA_ROUTES),
  ].map(
    (route): RouteDefinition => ({
      method: route.method,
      pattern: route.pattern,
      handler: route.handler,
      // Include validation function if present (new-style routes from defineEndpoint)
      validate: 'validate' in route ? (route.validate as RouteDefinition['validate']) : undefined,
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
    if (part.startsWith('...')) {
      const paramName = part.slice(3) // Remove '...' prefix
      params[paramName] = actualCopy.join('/')
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
 * Specificity rank of a pattern segment. Higher wins.
 * A literal ("static") segment is more specific than a `:param`, which is
 * more specific than a `...catchall`.
 */
const STATIC_RANK = 2
const DYNAMIC_RANK = 1
const CATCHALL_RANK = 0

/**
 * Rank of the pattern segment governing position `index`.
 * A catch-all at or before `index` governs every position from there on
 * (in this codebase a catch-all is always the last pattern segment, so it
 * effectively "consumes" every subsequent position).
 */
const segmentRankAt = (pattern: readonly string[], index: number): number => {
  for (let i = 0; i <= index && i < pattern.length; i++) {
    if (pattern[i].startsWith('...')) return CATCHALL_RANK
  }
  if (index >= pattern.length) return CATCHALL_RANK
  return pattern[index].startsWith(':') ? DYNAMIC_RANK : STATIC_RANK
}

/**
 * Compare two route patterns for specificity, position by position, for
 * routes that both matched the same actual segments.
 *
 * Returns a negative number if `a` is more specific than `b`, positive if
 * `b` is more specific than `a`, and 0 if they are tied (in which case the
 * caller should keep whichever route it already picked, so registration
 * order acts as the final, deterministic tiebreaker).
 */
const compareSpecificity = (a: readonly string[], b: readonly string[]): number => {
  const maxLen = Math.max(a.length, b.length)
  for (let i = 0; i < maxLen; i++) {
    const rankA = segmentRankAt(a, i)
    const rankB = segmentRankAt(b, i)
    if (rankA !== rankB) return rankB - rankA
    // Once both patterns are consuming a catch-all, no further position can
    // distinguish them.
    if (rankA === CATCHALL_RANK) break
  }
  return 0
}

/**
 * Find the most specific matching route for a method + path.
 *
 * Scans every route (not just the first structural match) so that route
 * *registration order* can never let a broad dynamic route (e.g. `:branch`)
 * shadow a narrower, differently-guarded static route (e.g. `assets`) that
 * happens to be registered later. Exported standalone (rather than inlined
 * into `createCanopyRouter`) so the precedence rule can be unit-tested
 * against synthetic route tables, independent of the real API surface.
 */
export function matchRoute(
  routes: readonly RouteDefinition[],
  method: string,
  segments: string[],
): RouteMatch | null {
  const upperMethod = method.toUpperCase()

  let best: { route: RouteDefinition; params: Record<string, string> } | null = null

  for (const route of routes) {
    if (route.method !== upperMethod) continue

    const match = matchPattern(route.pattern, segments)
    if (!match) continue

    // Among all routes that match this request, pick the most specific one
    // (static segments beat :params, which beat ...catchalls).
    if (!best || compareSpecificity(route.pattern, best.route.pattern) < 0) {
      best = { route, params: match.params }
    }
  }

  if (!best) return null

  return {
    handler: best.route.handler,
    params: best.params,
    validate: best.route.validate, // Include validation function if present
  }
}

/**
 * Create the standard Canopy router with all API routes.
 */
export function createCanopyRouter(): CanopyRouter {
  const routes = buildCanopyRoutes()

  return {
    routes,
    match: (method: string, segments: string[]) => matchRoute(routes, method, segments),
  }
}
