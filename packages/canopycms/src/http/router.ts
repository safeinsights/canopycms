import type { ApiResponse } from '../api/types'
import type { CanopyBinaryResponse } from './types'
import { BRANCH_ROUTES } from '../api/branch'
import { WORKFLOW_ROUTES } from '../api/branch-status'
import { COMMENT_ROUTES } from '../api/comments'
import { CONTENT_ROUTES } from '../api/content'
import { REFERENCE_OPTIONS_ROUTES } from '../api/reference-options'
import { RESOLVE_REFERENCES_ROUTES } from '../api/resolve-references'
import { ENTRY_ROUTES } from '../api/entries'
import { ASSET_ROUTES, assetRawRoute } from '../api/assets'
import { PERMISSION_ROUTES } from '../api/permissions'
import { GROUP_ROUTES } from '../api/groups'
import { USER_ROUTES } from '../api/user'
import { SCHEMA_ROUTES } from '../api/schema'
import { ADMIN_ROUTES } from '../api/admin'

/**
 * `any` because handler signatures differ: some take (ctx, req, params), others
 * (ctx, params). The return type includes `CanopyBinaryResponse` so byte-
 * streaming routes share this route table with JSON ones; http/handler.ts
 * discriminates on `kind` before wrapping a result in a JSON envelope.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CanopyHandler = (...args: any[]) => Promise<ApiResponse<any> | CanopyBinaryResponse>

/** Route definition for the Canopy API. */
export interface RouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  pattern: readonly string[] // e.g., [':branch', 'content', ':collection', '...slug']
  handler: CanopyHandler
  // Present on routes defined with defineEndpoint().
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
  /**
   * Opts out of the core handler's eager `req.json()` (see http/handler.ts).
   * Set by routes taking a non-JSON body: the body stream is single-use, so
   * such a handler must read it itself via `req.formData()`.
   */
  bodyFormat?: 'multipart'
}

export interface RouteMatch {
  handler: CanopyHandler
  params: Record<string, string>
  validate?: RouteDefinition['validate']
  bodyFormat?: RouteDefinition['bodyFormat']
}

/** Core router: framework-agnostic route matching. */
export interface CanopyRouter {
  readonly routes: RouteDefinition[]

  match(method: string, segments: string[]): RouteMatch | null
}

/**
 * Assembled from the route definitions co-located in each API module. A
 * function, not a top-level constant, so every route module is fully
 * initialized before its exports are read.
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
    assetRawRoute,
    ...Object.values(PERMISSION_ROUTES),
    ...Object.values(GROUP_ROUTES),
    ...Object.values(USER_ROUTES),
    ...Object.values(SCHEMA_ROUTES),
    ...Object.values(ADMIN_ROUTES),
  ].map(
    (route): RouteDefinition => ({
      method: route.method,
      pattern: route.pattern,
      handler: route.handler,
      validate: 'validate' in route ? (route.validate as RouteDefinition['validate']) : undefined,
      bodyFormat:
        'bodyFormat' in route ? (route.bodyFormat as RouteDefinition['bodyFormat']) : undefined,
    }),
  )
}

/**
 * Match a route pattern against actual path segments: `:param` takes one
 * segment, `...slug` takes the rest.
 *
 * Params come back RAW (undecoded) on purpose (C5): matching is purely
 * structural and must NEVER throw. Decoding happens exactly once, uniformly for
 * `:param` and catch-all alike, in matchRoute() below, after the winning route
 * is picked — so a malformed `%` escape is handled in one place instead of
 * aborting mid-match, where the URIError would reach http/handler.ts's
 * top-level catch and surface as a 500 rather than a 400.
 */
const matchPattern = (
  pattern: readonly string[],
  actual: string[],
): { params: Record<string, string> } | null => {
  const params: Record<string, string> = {}
  const actualCopy = [...actual]

  for (const part of pattern) {
    if (part.startsWith('...')) {
      const paramName = part.slice(3) // Remove '...' prefix
      params[paramName] = actualCopy.join('/')
      actualCopy.length = 0
      break
    }

    const next = actualCopy.shift()
    if (!next) return null

    if (part.startsWith(':')) {
      // Still raw; see the decode note above.
      params[part.slice(1)] = next
    } else if (part !== next) {
      return null
    }
  }

  if (actualCopy.length > 0) return null

  return { params }
}

/**
 * Synthetic handler for matched params carrying a malformed `%` escape (C5) —
 * a lone `%`, `%zz`. The request is malformed, so it answers 400. Never
 * registered in the route table; only matchRoute()'s decode step reaches it.
 */
const malformedPathHandler: CanopyHandler = async () => ({
  ok: false,
  status: 400,
  error: 'Malformed URL-encoded path segment',
})

/**
 * Specificity rank of a pattern segment, higher wins: a literal beats a
 * `:param`, which beats a `...catchall`.
 */
const STATIC_RANK = 2
const DYNAMIC_RANK = 1
const CATCHALL_RANK = 0

/**
 * Rank of the pattern segment governing position `index`. A catch-all at or
 * before `index` governs every position from there on — it is always the last
 * pattern segment here, so it consumes everything after itself.
 */
const segmentRankAt = (pattern: readonly string[], index: number): number => {
  for (let i = 0; i <= index && i < pattern.length; i++) {
    if (pattern[i].startsWith('...')) return CATCHALL_RANK
  }
  if (index >= pattern.length) return CATCHALL_RANK
  return pattern[index].startsWith(':') ? DYNAMIC_RANK : STATIC_RANK
}

/**
 * Compare two patterns that both matched, position by position: negative when
 * `a` is more specific, positive when `b` is, 0 when tied. On a tie the caller
 * keeps the route it already picked, so registration order is the final,
 * deterministic tiebreaker.
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
 * Scans EVERY route, not just the first structural match, so registration order
 * can never let a broad dynamic route (`:branch`) shadow a narrower,
 * differently-guarded static one (`assets`) registered later. Exported
 * standalone so that precedence rule can be unit-tested against synthetic route
 * tables, independent of the real API surface.
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

    if (!best || compareSpecificity(route.pattern, best.route.pattern) < 0) {
      best = { route, params: match.params }
    }
  }

  if (!best) return null

  // Decode every matched param exactly once, here, uniformly for :param and
  // catch-all alike (C5). A malformed escape MUST produce a 400, not an
  // uncaught URIError reaching http/handler.ts's top-level catch as a 500.
  // Decoding centrally does not replace downstream validation: each route's
  // `validate` (Zod's logicalPathSchema/branchNameSchema) and any handler-local
  // re-check still run their own traversal checks against this decoded value.
  let decodedParams: Record<string, string>
  try {
    decodedParams = Object.fromEntries(
      Object.entries(best.params).map(([key, value]) => [key, decodeURIComponent(value)]),
    )
  } catch {
    return { handler: malformedPathHandler, params: {} }
  }

  return {
    handler: best.route.handler,
    params: decodedParams,
    validate: best.route.validate, // Include validation function if present
    bodyFormat: best.route.bodyFormat,
  }
}

export function createCanopyRouter(): CanopyRouter {
  const routes = buildCanopyRoutes()

  return {
    routes,
    match: (method: string, segments: string[]) => matchRoute(routes, method, segments),
  }
}
