import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { CommentThread, CommentType } from '../comment-store'
import { CommentStore } from '../comment-store'
import { isReviewer } from '../reserved-groups'
import { defineEndpoint } from './route-builder'

interface AddCommentRequest {
  text: string
  threadId?: string
  type: CommentType
  entryId?: string
  canopyPath?: string
}

export interface ListCommentsResponse {
  threads: CommentThread[]
}

/** Response type for listing comments */
export type CommentsResponse = ApiResponse<ListCommentsResponse>

/** Response type for adding a comment */
export type AddCommentResponse = ApiResponse<{ threadId: string; commentId: string }>

/** Response type for resolving a comment */
export type ResolveCommentResponse = ApiResponse<{ resolved: boolean }>

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

const branchParamSchema = z.object({
  branch: z.string().min(1),
})

const threadParamSchema = z.object({
  branch: z.string().min(1),
  threadId: z.string().min(1),
})

const addCommentBodySchema = z.object({
  text: z.string().min(1),
  threadId: z.string().optional(),
  type: z.enum(['field', 'entry', 'branch']),
  entryId: z.string().optional(),
  canopyPath: z.string().optional(),
})

const listCommentsHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof branchParamSchema>,
): Promise<CommentsResponse> => {
  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const access = ctx.services.checkBranchAccess(context, req.user)
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  const commentStore = new CommentStore(context.branchRoot)

  const threads = await commentStore.listThreads({ includeResolved: true })

  return { ok: true, status: 200, data: { threads } }
}

const addCommentHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof branchParamSchema>,
  body: z.infer<typeof addCommentBodySchema>,
): Promise<AddCommentResponse> => {
  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const access = ctx.services.checkBranchAccess(context, req.user)
  if (!access.allowed) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  // Validate required fields based on type
  if (body.type === 'field' && !body.canopyPath) {
    return { ok: false, status: 400, error: 'canopyPath required for field comments' }
  }

  if ((body.type === 'field' || body.type === 'entry') && !body.entryId) {
    return { ok: false, status: 400, error: 'entryId required for field/entry comments' }
  }

  const commentStore = new CommentStore(context.branchRoot)

  const result = await commentStore.addComment({
    userId: req.user.userId,
    text: body.text,
    threadId: body.threadId,
    type: body.type,
    entryId: body.entryId,
    canopyPath: body.canopyPath,
  })

  return { ok: true, status: 200, data: result }
}

const resolveCommentHandler = async (
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof threadParamSchema>,
): Promise<ResolveCommentResponse> => {
  const context = await ctx.getBranchContext(params.branch)
  if (!context) {
    return { ok: false, status: 404, error: 'Branch not found' }
  }

  const commentStore = new CommentStore(context.branchRoot)

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

// ============================================================================
// Route Definitions with defineEndpoint
// ============================================================================

/**
 * List all comment threads for a branch
 * GET /:branch/comments
 */
const listComments = defineEndpoint({
  namespace: 'comments',
  name: 'list',
  method: 'GET',
  path: '/:branch/comments',
  params: branchParamSchema,
  responseType: 'CommentsResponse',
  response: {} as CommentsResponse,
  defaultMockData: { threads: [] },
  handler: listCommentsHandler,
})

/**
 * Add a comment to a thread or create new thread
 * POST /:branch/comments
 */
const addComment = defineEndpoint({
  namespace: 'comments',
  name: 'add',
  method: 'POST',
  path: '/:branch/comments',
  params: branchParamSchema,
  body: addCommentBodySchema,
  responseType: 'AddCommentResponse',
  response: {} as AddCommentResponse,
  defaultMockData: { threadId: 'mock-thread-id', commentId: 'mock-comment-id' },
  handler: addCommentHandler,
})

/**
 * Resolve a comment thread
 * POST /:branch/comments/:threadId/resolve
 */
const resolveComment = defineEndpoint({
  namespace: 'comments',
  name: 'resolve',
  method: 'POST',
  path: '/:branch/comments/:threadId/resolve',
  params: threadParamSchema,
  responseType: 'ResolveCommentResponse',
  response: {} as ResolveCommentResponse,
  defaultMockData: { resolved: true },
  handler: resolveCommentHandler,
})

/**
 * Exported routes for router registration
 */
export const COMMENT_ROUTES = {
  list: listComments,
  add: addComment,
  resolve: resolveComment,
} as const
