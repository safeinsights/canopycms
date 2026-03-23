/**
 * Declarative guard system for API endpoints.
 *
 * Guards run before the handler and either:
 * - Return an error response (404, 403, 500) to short-circuit
 * - Produce a guard context (e.g., branch context with schema) for the handler
 *
 * Usage in defineEndpoint:
 * ```ts
 * defineEndpoint({
 *   guards: ['branchAccessWithSchema'] as const,
 *   handler: async (gc, ctx, req, params) => {
 *     // gc.branchContext is guaranteed non-null with flatSchema
 *   }
 * })
 * ```
 */

import type { BranchContext, BranchContextWithSchema } from '../types'
import type { ApiContext, ApiRequest, ApiResponse } from './types'
import { isAdmin, isReviewer, isPrivileged } from '../authorization/helpers'

// ============================================================================
// Guard IDs and Context Map
// ============================================================================

/** All available guard identifiers */
export type GuardId =
  | 'branch'
  | 'branchAccess'
  | 'schema'
  | 'branchAccessWithSchema'
  | 'admin'
  | 'reviewer'
  | 'privileged'

/** Maps each guard ID to the context it contributes */
export interface GuardContextMap {
  branch: { branchContext: BranchContext }
  branchAccess: { branchContext: BranchContext }
  schema: { branchContext: BranchContextWithSchema }
  branchAccessWithSchema: { branchContext: BranchContextWithSchema }
  admin: Record<string, never>
  reviewer: Record<string, never>
  privileged: Record<string, never>
}

// ============================================================================
// Type-level computation of guard context
// ============================================================================

/** Helper: convert union to intersection */
type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never

/** Compute the guard context type from a tuple of guard IDs */
export type ComputeGuardContext<T extends readonly GuardId[]> = UnionToIntersection<
  GuardContextMap[T[number]]
>

// ============================================================================
// Guard runner types
// ============================================================================

/** Result of a single guard execution */
type GuardRunnerResult =
  | { ok: true; context: Partial<GuardContext> }
  | { ok: false; response: ApiResponse<never> }

/** Accumulated guard context (runtime shape) */
interface GuardContext {
  branchContext?: BranchContext | BranchContextWithSchema
}

/** A guard runner function */
type GuardRunner = (
  ctx: ApiContext,
  req: ApiRequest,
  params: Record<string, unknown>,
  accumulated: GuardContext,
) => Promise<GuardRunnerResult>

// ============================================================================
// Guard runner implementations
// ============================================================================

/** Extracts branch name from params, returning error response if missing */
function extractBranchName(params: Record<string, unknown>): string | ApiResponse<never> {
  const branch = params.branch
  if (typeof branch !== 'string' || !branch) {
    return { ok: false, status: 400, error: 'Branch parameter required' }
  }
  return branch
}

const runBranchGuard: GuardRunner = async (ctx, _req, params) => {
  const branch = extractBranchName(params)
  if (typeof branch !== 'string') return { ok: false, response: branch }

  const context = await ctx.getBranchContext(branch)
  if (!context) {
    return { ok: false, response: { ok: false, status: 404, error: 'Branch not found' } }
  }
  return { ok: true, context: { branchContext: context } }
}

const runBranchAccessGuard: GuardRunner = async (ctx, req, params) => {
  const branch = extractBranchName(params)
  if (typeof branch !== 'string') return { ok: false, response: branch }

  const context = await ctx.getBranchContext(branch)
  if (!context) {
    return { ok: false, response: { ok: false, status: 404, error: 'Branch not found' } }
  }

  const access = ctx.services.checkBranchAccess(context, req.user)
  if (!access.allowed) {
    return {
      ok: false,
      response: { ok: false, status: 403, error: access.reason || 'Forbidden' },
    }
  }

  return { ok: true, context: { branchContext: context } }
}

const runSchemaGuard: GuardRunner = async (ctx, _req, params) => {
  const branch = extractBranchName(params)
  if (typeof branch !== 'string') return { ok: false, response: branch }

  const context = await ctx.getBranchContext(branch, { loadSchema: true })
  if (!context) {
    return { ok: false, response: { ok: false, status: 404, error: 'Branch not found' } }
  }
  if (!context.flatSchema) {
    return {
      ok: false,
      response: { ok: false, status: 500, error: 'Schema not loaded for branch' },
    }
  }

  return { ok: true, context: { branchContext: context as BranchContextWithSchema } }
}

const runBranchAccessWithSchemaGuard: GuardRunner = async (ctx, req, params) => {
  const branch = extractBranchName(params)
  if (typeof branch !== 'string') return { ok: false, response: branch }

  // Load branch with schema and check access
  const context = await ctx.getBranchContext(branch, { loadSchema: true })
  if (!context) {
    return { ok: false, response: { ok: false, status: 404, error: 'Branch not found' } }
  }

  const access = ctx.services.checkBranchAccess(context, req.user)
  if (!access.allowed) {
    return {
      ok: false,
      response: { ok: false, status: 403, error: access.reason || 'Forbidden' },
    }
  }

  if (!context.flatSchema) {
    return {
      ok: false,
      response: { ok: false, status: 500, error: 'Schema not loaded for branch' },
    }
  }

  return { ok: true, context: { branchContext: context as BranchContextWithSchema } }
}

const runAdminGuard: GuardRunner = async (_ctx, req) => {
  if (!isAdmin(req.user.groups)) {
    return {
      ok: false,
      response: { ok: false, status: 403, error: 'Admin access required' },
    }
  }
  return { ok: true, context: {} }
}

const runReviewerGuard: GuardRunner = async (_ctx, req) => {
  if (!isReviewer(req.user.groups)) {
    return {
      ok: false,
      response: { ok: false, status: 403, error: 'Reviewer access required' },
    }
  }
  return { ok: true, context: {} }
}

const runPrivilegedGuard: GuardRunner = async (_ctx, req) => {
  if (!isPrivileged(req.user.groups)) {
    return {
      ok: false,
      response: { ok: false, status: 403, error: 'Privileged access required' },
    }
  }
  return { ok: true, context: {} }
}

// ============================================================================
// Guard registry
// ============================================================================

const GUARD_RUNNERS: Record<GuardId, GuardRunner> = {
  branch: runBranchGuard,
  branchAccess: runBranchAccessGuard,
  schema: runSchemaGuard,
  branchAccessWithSchema: runBranchAccessWithSchemaGuard,
  admin: runAdminGuard,
  reviewer: runReviewerGuard,
  privileged: runPrivilegedGuard,
}

// ============================================================================
// Guard execution
// ============================================================================

/** Result of executeGuards */
export type ExecuteGuardsResult<T extends readonly GuardId[]> =
  | { ok: true; guardContext: ComputeGuardContext<T> }
  | { ok: false; response: ApiResponse<never> }

/**
 * Execute a chain of guards in order.
 * Returns the accumulated guard context on success, or the first error response on failure.
 */
export async function executeGuards<T extends readonly GuardId[]>(
  guards: T,
  ctx: ApiContext,
  req: ApiRequest,
  params: Record<string, unknown>,
): Promise<ExecuteGuardsResult<T>> {
  const accumulated: GuardContext = {}

  for (const guardId of guards) {
    const runner = GUARD_RUNNERS[guardId]
    const result = await runner(ctx, req, params, accumulated)
    if (!result.ok) {
      return { ok: false, response: result.response }
    }
    // Merge context contributions
    Object.assign(accumulated, result.context)
  }

  return { ok: true, guardContext: accumulated as ComputeGuardContext<T> }
}
