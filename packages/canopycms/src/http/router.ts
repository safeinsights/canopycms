import type { ApiContext, ApiRequest, ApiResponse } from '../api/types'
import { createBranch, listBranches, deleteBranch, updateBranchAccess } from '../api/branch'
import { getBranchStatus, submitBranchForMerge } from '../api/branch-status'
import { withdrawBranch } from '../api/branch-withdraw'
import { requestChanges, approveBranch } from '../api/branch-review'
import { markAsMerged } from '../api/branch-merge'
import { readContent, writeContent } from '../api/content'
import { deleteAsset, listAssets, uploadAsset } from '../api/assets'
import { listEntries } from '../api/entries'
import { listComments, addComment, resolveComment } from '../api/comments'
import { getPermissions, updatePermissions, searchUsers, listGroups } from '../api/permissions'
import { getInternalGroups, updateInternalGroups, searchExternalGroups } from '../api/groups'

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
  pattern: string[] // e.g., [':branch', 'content', ':collection', '...slug']
  handler: CanopyHandler
}

/**
 * Result of route matching.
 */
export interface RouteMatch {
  handler: CanopyHandler
  params: Record<string, string>
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
 * Standard route definitions for the Canopy API.
 * These are the built-in routes that all adapters use.
 */
export const CANOPY_ROUTES: RouteDefinition[] = [
  // Branch management
  { method: 'GET', pattern: ['branches'], handler: listBranches },
  { method: 'POST', pattern: ['branches'], handler: createBranch },
  { method: 'DELETE', pattern: [':branch'], handler: deleteBranch },
  { method: 'PATCH', pattern: [':branch', 'access'], handler: updateBranchAccess },

  // Branch workflow
  { method: 'GET', pattern: [':branch', 'status'], handler: getBranchStatus },
  { method: 'POST', pattern: [':branch', 'submit'], handler: submitBranchForMerge },
  { method: 'POST', pattern: [':branch', 'withdraw'], handler: withdrawBranch },
  { method: 'POST', pattern: [':branch', 'request-changes'], handler: requestChanges },
  { method: 'POST', pattern: [':branch', 'approve'], handler: approveBranch },
  { method: 'POST', pattern: [':branch', 'mark-merged'], handler: markAsMerged },

  // Comments
  { method: 'GET', pattern: [':branch', 'comments'], handler: listComments },
  { method: 'POST', pattern: [':branch', 'comments'], handler: addComment },
  {
    method: 'POST',
    pattern: [':branch', 'comments', ':threadId', 'resolve'],
    handler: resolveComment,
  },

  // Content
  {
    method: 'GET',
    pattern: [':branch', 'content', ':collection', '...slug'],
    handler: readContent,
  },
  {
    method: 'PUT',
    pattern: [':branch', 'content', ':collection', '...slug'],
    handler: writeContent,
  },

  // Assets
  { method: 'GET', pattern: ['assets'], handler: listAssets },
  { method: 'POST', pattern: ['assets'], handler: uploadAsset },
  { method: 'DELETE', pattern: ['assets'], handler: deleteAsset },

  // Entries
  { method: 'GET', pattern: [':branch', 'entries'], handler: listEntries },

  // Permissions
  { method: 'GET', pattern: ['permissions'], handler: getPermissions },
  { method: 'PUT', pattern: ['permissions'], handler: updatePermissions },
  { method: 'GET', pattern: ['users', 'search'], handler: searchUsers },
  { method: 'GET', pattern: ['groups'], handler: listGroups },

  // Groups
  { method: 'GET', pattern: ['groups', 'internal'], handler: getInternalGroups },
  { method: 'PUT', pattern: ['groups', 'internal'], handler: updateInternalGroups },
  { method: 'GET', pattern: ['groups', 'search'], handler: searchExternalGroups },
]

/**
 * Match a route pattern against actual path segments.
 * Supports :param for single-segment params and ...slug for catch-all.
 */
const matchPattern = (
  pattern: string[],
  actual: string[]
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
  return {
    routes: CANOPY_ROUTES,

    match(method: string, segments: string[]): RouteMatch | null {
      const upperMethod = method.toUpperCase()

      for (const route of CANOPY_ROUTES) {
        if (route.method !== upperMethod) continue

        const match = matchPattern(route.pattern, segments)
        if (match) {
          return { handler: route.handler, params: match.params }
        }
      }

      return null
    },
  }
}
