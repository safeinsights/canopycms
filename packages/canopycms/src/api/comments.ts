import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { CommentThread } from '../comment-store'
import { CommentStore } from '../comment-store'
import { resolveBranchWorkspace } from '../paths'

interface AddCommentRequest {
  text: string
  threadId?: string
  filePath?: string
  lineNumber?: number
  type?: 'review' | 'discussion'
}

interface ListCommentsResponse {
  threads: CommentThread[]
}

/**
 * List all comment threads for a branch
 */
export const listComments = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: { branch: string },
): Promise<ApiResponse<ListCommentsResponse>> => {
  const state = await ctx.getBranchState(params.branch)
  if (!state) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const access = ctx.services.checkBranchAccess(state, req.user)
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const branchPaths = resolveBranchWorkspace(state, branchMode)
  const commentStore = new CommentStore(branchPaths.metadataRoot)

  const threads = await commentStore.listThreads({ includeResolved: true })

  return { ok: true, status: 200, data: { threads } }
}

/**
 * Add a comment to a branch (creates new thread or adds to existing)
 */
export const addComment = async (
  ctx: ApiContext,
  req: ApiRequest<AddCommentRequest>,
  params: { branch: string },
): Promise<ApiResponse<{ threadId: string; commentId: string }>> => {
  const state = await ctx.getBranchState(params.branch)
  if (!state) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const access = ctx.services.checkBranchAccess(state, req.user)
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  if (!req.body?.text) {
    return { ok: false, status: 400, error: 'Comment text is required' }
  }

  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const branchPaths = resolveBranchWorkspace(state, branchMode)
  const commentStore = new CommentStore(branchPaths.metadataRoot)

  const result = await commentStore.addComment({
    userId: req.user.userId,
    text: req.body.text,
    threadId: req.body.threadId,
    filePath: req.body.filePath,
    lineNumber: req.body.lineNumber,
    type: req.body.type || 'discussion',
  })

  return { ok: true, status: 200, data: result }
}

/**
 * Resolve a comment thread (manager/admin only)
 */
export const resolveComment = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: { branch: string; threadId: string },
): Promise<ApiResponse<{ resolved: boolean }>> => {
  const state = await ctx.getBranchState(params.branch)
  if (!state) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  // Check user has manager/admin role
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return {
      ok: false,
      status: 403,
      error: 'Only admins and managers can resolve comments',
    }
  }

  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const branchPaths = resolveBranchWorkspace(state, branchMode)
  const commentStore = new CommentStore(branchPaths.metadataRoot)

  const resolved = await commentStore.resolveThread(params.threadId)
  if (!resolved) {
    return { ok: false, status: 404, error: 'Thread not found' }
  }

  return { ok: true, status: 200, data: { resolved: true } }
}
