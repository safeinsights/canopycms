/**
 * Branch access guard middleware.
 *
 * Extracts the common pattern of:
 * 1. Loading branch context
 * 2. Checking if branch exists (404)
 * 3. Checking if user has branch access (403)
 *
 * This pattern was repeated across ~7 API handlers.
 */

import type { BranchContext } from '../../types'
import type { ApiContext, ApiRequest, ApiResponse } from '../types'

/** Success result with branch context */
export interface BranchAccessSuccess {
  context: BranchContext
}

/** Error result that can be returned directly from handler */
export type BranchAccessError = ApiResponse<never>

/** Result of branch access check */
export type BranchAccessResult = BranchAccessSuccess | BranchAccessError

/**
 * Check if result is an error response.
 * Use this to narrow the type and return early from handlers.
 *
 * @example
 * ```ts
 * const result = await guardBranchAccess(ctx, req, params.branch)
 * if (isBranchAccessError(result)) return result
 * const { context } = result
 * // ... continue with context
 * ```
 */
export function isBranchAccessError(result: BranchAccessResult): result is BranchAccessError {
  return 'ok' in result && result.ok === false
}

/**
 * Guard that checks branch existence and user access.
 *
 * Returns either:
 * - Success with branch context
 * - Error response (404 or 403) that can be returned directly
 *
 * @param ctx - API context with services and getBranchContext
 * @param req - API request with user info
 * @param branchName - Name of branch to check
 * @returns Branch context on success, or error response
 *
 * @example
 * ```ts
 * const result = await guardBranchAccess(ctx, req, params.branch)
 * if (isBranchAccessError(result)) return result
 * const { context } = result
 * // ... use context
 * ```
 */
export async function guardBranchAccess(
  ctx: ApiContext,
  req: ApiRequest,
  branchName: string
): Promise<BranchAccessResult> {
  const context = await ctx.getBranchContext(branchName)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const access = ctx.services.checkBranchAccess(context, req.user)
  if (!access.allowed) {
    return { ok: false, status: 403, error: access.reason || 'Forbidden' }
  }

  return { context }
}

/**
 * Guard that only checks branch existence (no access check).
 *
 * Use this when you need the branch context but will do content-level
 * access checks later (e.g., for per-file permissions).
 *
 * @param ctx - API context with getBranchContext
 * @param branchName - Name of branch to check
 * @returns Branch context on success, or 404 error response
 */
export async function guardBranchExists(
  ctx: ApiContext,
  branchName: string
): Promise<BranchAccessResult> {
  const context = await ctx.getBranchContext(branchName)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  return { context }
}
