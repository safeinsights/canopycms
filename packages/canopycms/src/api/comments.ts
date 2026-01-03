import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { CommentThread, CommentType } from '../comment-store'
import { CommentStore } from '../comment-store'
import { resolveBranchPaths } from '../paths'
import { isReviewer } from '../reserved-groups'

interface AddCommentRequest {
  text: string
  threadId?: string
  type: CommentType
  entryId?: string
  canopyPath?: string
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
  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const access = ctx.services.checkBranchAccess(context, req.user)
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const branchPaths = resolveBranchPaths(context, branchMode)
  const commentStore = new CommentStore(branchPaths.branchRoot)

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
  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const access = ctx.services.checkBranchAccess(context, req.user)
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  if (!req.body?.text) {
    return { ok: false, status: 400, error: 'Comment text is required' }
  }

  if (!req.body?.type) {
    return { ok: false, status: 400, error: 'Comment type is required' }
  }

  // Validate required fields based on type
  if (req.body.type === 'field' && !req.body.canopyPath) {
    return { ok: false, status: 400, error: 'canopyPath required for field comments' }
  }

  if ((req.body.type === 'field' || req.body.type === 'entry') && !req.body.entryId) {
    return { ok: false, status: 400, error: 'entryId required for field/entry comments' }
  }

  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const branchPaths = resolveBranchPaths(context, branchMode)
  const commentStore = new CommentStore(branchPaths.branchRoot)

  const result = await commentStore.addComment({
    userId: req.user.userId,
    text: req.body.text,
    threadId: req.body.threadId,
    type: req.body.type,
    entryId: req.body.entryId,
    canopyPath: req.body.canopyPath,
  })

  return { ok: true, status: 200, data: result }
}

/**
 * Resolve a comment thread
 * Can be resolved by: thread author, reviewer, or admin
 */
export const resolveComment = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: { branch: string; threadId: string },
): Promise<ApiResponse<{ resolved: boolean }>> => {
  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const branchMode = ctx.services.config.mode ?? 'local-simple'
  const branchPaths = resolveBranchPaths(context, branchMode)
  const commentStore = new CommentStore(branchPaths.branchRoot)

  // Get the thread to check permissions
  const thread = await commentStore.getThread(params.threadId)
  if (!thread) {
    return { ok: false, status: 404, error: 'Thread not found' }
  }

  // Check permissions: thread author, reviewer, or admin
  const isAuthor = thread.authorId === req.user.userId
  const userIsReviewer = isReviewer(req.user.groups)

  if (!isAuthor && !userIsReviewer) {
    return {
      ok: false,
      status: 403,
      error: 'Only thread author, Reviewers, or Admins can resolve comments',
    }
  }

  const resolved = await commentStore.resolveThread(params.threadId, req.user.userId)
  if (!resolved) {
    return { ok: false, status: 404, error: 'Thread not found' }
  }

  return { ok: true, status: 200, data: { resolved: true } }
}
