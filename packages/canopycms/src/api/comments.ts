import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { BranchContext } from '../types'
import type { CommentThread, CommentType } from '../comment-store'
import { CommentStore } from '../comment-store'
import type { UserProfile } from '../auth/types'
import { lookupUsersMetadata } from '../auth/user-metadata-lookup'
import { isSystemUserId } from '../system-users'
import { ANONYMOUS_USER } from '../user'
import { getErrorMessage } from '../utils/error'
import { isReviewer } from '../authorization'
import type { ContentAccessChecker } from '../authorization'
import { parseLogicalPath } from '../paths/validation'
import type { LogicalPath } from '../paths/types'
import { normalizeFilesystemPath } from '../paths/normalize'
import { defineEndpoint } from './route-builder'
import { branchParamSchema, branchNameSchema, logicalPathSchema } from './validators'

export interface AddCommentBody {
  text: string
  threadId?: string
  type: CommentType
  entryPath?: string
  canopyPath?: string
}

interface ListCommentsResponse {
  threads: CommentThread[]
  /** Profiles of the people who wrote or resolved `threads`, in no order; unknown ids are absent. */
  users: UserProfile[]
}

/** Response type for listing comments */
export type CommentsResponse = ApiResponse<ListCommentsResponse>

/** Response type for adding a comment */
export type AddCommentResponse = ApiResponse<{
  threadId: string
  commentId: string
}>

/** Response type for resolving a comment */
export type ResolveCommentResponse = ApiResponse<{ resolved: boolean }>

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

const threadParamSchema = z.object({
  branch: branchNameSchema,
  threadId: z.string().min(1),
})

const addCommentBodySchema = z.object({
  text: z.string().min(1),
  threadId: z.string().optional(),
  type: z.enum(['field', 'entry', 'branch']),
  entryPath: logicalPathSchema.optional(),
  canopyPath: z.string().optional(), // Canopy field path, not a file path
})

/**
 * Whether `entryPath` is spelled the way path rules expect an entry's logical path: rooted at
 * the content root, with no empty or `.` segment. Rules are globs over that spelling, so
 * `secret/plan` (which the content API reads as `content/secret/plan`) and
 * `content/./secret/plan` both miss a rule written for `content/secret/**`.
 */
const isCanonicalEntryPath = (entryPath: LogicalPath, contentRoot: string): boolean =>
  entryPath.startsWith(`${normalizeFilesystemPath(contentRoot)}/`) &&
  entryPath.split('/').every((segment) => segment !== '' && segment !== '.')

/**
 * Whether the user may see a thread: its entry's path rules at `read`, the level a content
 * read needs, so a thread discloses nothing about an entry its reader could not open. A
 * field thread is governed by its entry. A thread with no entry path (a branch thread) is
 * governed by branch access alone, which the `branchAccess` guard has already passed. An
 * entry path that is not a canonical logical path is denied: comments.json is read without
 * schema validation.
 */
const canReadThreadEntry = (
  checkAccess: ContentAccessChecker,
  contentRoot: string,
  entryPath: string | undefined,
): boolean => {
  if (entryPath === undefined) return true
  const parsed = parseLogicalPath(entryPath)
  return (
    parsed.ok &&
    isCanonicalEntryPath(parsed.path, contentRoot) &&
    checkAccess(parsed.path, 'read').allowed
  )
}

/** One checker per request, bound to the content root its paths are canonical against. */
const createThreadReadCheck = async (
  ctx: ApiContext,
  req: ApiRequest,
  branchContext: BranchContext,
): Promise<(entryPath: string | undefined) => boolean> => {
  const checkAccess = await ctx.services.createContentAccessChecker(
    branchContext,
    branchContext.branchRoot,
    req.user,
  )
  const contentRoot = ctx.services.config.contentRoot || 'content'
  return (entryPath) => canReadThreadEntry(checkAccess, contentRoot, entryPath)
}

/** Matches the id bound `/users/batch` accepts; comments.json is read without validation. */
const MAX_USER_ID_LENGTH = 256

/**
 * The profile of everyone who wrote or resolved one of `threads`, looked up only for threads
 * already filtered to what the requester may read, so the list names no one the requester could
 * not see in a thread. Bots and the anonymous user are left to the editor, which labels them
 * without a lookup. A failed lookup costs the names, never the threads.
 */
const lookupThreadUsers = async (
  ctx: ApiContext,
  threads: readonly CommentThread[],
): Promise<UserProfile[]> => {
  const authPlugin = ctx.authPlugin
  if (!authPlugin) return []
  try {
    const ids = new Set<unknown>()
    for (const thread of threads) {
      ids.add(thread.authorId)
      ids.add(thread.resolvedBy)
      // comments.json is parsed without validation, so a thread may lack its comment list.
      if (Array.isArray(thread.comments)) {
        for (const comment of thread.comments) ids.add(comment?.userId)
      }
    }
    const wanted = [...ids].filter(
      (id): id is string =>
        typeof id === 'string' &&
        id.length > 0 &&
        id.length <= MAX_USER_ID_LENGTH &&
        id !== ANONYMOUS_USER.userId &&
        !isSystemUserId(id),
    )
    if (wanted.length === 0) return []
    const found = await lookupUsersMetadata(authPlugin, wanted)
    const users: UserProfile[] = []
    // Built field by field: a provider's user record carries an email, which this list never does.
    for (const user of found.values()) {
      if (user === null) continue
      users.push(
        user.avatarUrl === undefined
          ? { id: user.id, name: user.name }
          : { id: user.id, name: user.name, avatarUrl: user.avatarUrl },
      )
    }
    return users
  } catch (error) {
    console.error('CanopyCMS: Failed to look up comment authors:', getErrorMessage(error))
    return []
  }
}

const listCommentsHandler = async (
  gc: { branchContext: BranchContext },
  ctx: ApiContext,
  req: ApiRequest,
  _params: z.infer<typeof branchParamSchema>,
): Promise<CommentsResponse> => {
  const { branchContext } = gc

  const commentStore = new CommentStore(branchContext.branchRoot)
  const [allThreads, canRead] = await Promise.all([
    commentStore.listThreads({ includeResolved: true }),
    createThreadReadCheck(ctx, req, branchContext),
  ])
  const threads = allThreads.filter((thread) => canRead(thread.entryPath))
  const users = await lookupThreadUsers(ctx, threads)

  return { ok: true, status: 200, data: { threads, users } }
}

const addCommentHandler = async (
  gc: { branchContext: BranchContext },
  ctx: ApiContext,
  req: ApiRequest,
  _params: z.infer<typeof branchParamSchema>,
  body: z.infer<typeof addCommentBodySchema>,
): Promise<AddCommentResponse> => {
  const { branchContext } = gc

  // Validate required fields based on type
  if (body.type === 'field' && !body.canopyPath) {
    return {
      ok: false,
      status: 400,
      error: 'canopyPath required for field comments',
    }
  }

  if ((body.type === 'field' || body.type === 'entry') && !body.entryPath) {
    return {
      ok: false,
      status: 400,
      error: 'entryPath required for field/entry comments',
    }
  }

  // Commenting needs read access to the entry the comment lands on. A reply lands on the
  // stored thread, so it is checked against that thread's entry path, which never changes
  // once the thread exists; a reply to a thread the user cannot read answers as missing, as
  // resolve does.
  const commentStore = new CommentStore(branchContext.branchRoot)
  const [existing, canRead] = await Promise.all([
    body.threadId ? commentStore.getThread(body.threadId) : Promise.resolve(null),
    createThreadReadCheck(ctx, req, branchContext),
  ])
  if (body.threadId) {
    if (!existing || !canRead(existing.entryPath)) {
      return { ok: false, status: 404, error: 'Thread not found' }
    }
    const reply = await commentStore.addReply({
      userId: req.user.userId,
      text: body.text,
      threadId: body.threadId,
    })
    if (!reply) {
      return { ok: false, status: 404, error: 'Thread not found' }
    }
    return { ok: true, status: 201, data: reply }
  }

  if (!canRead(body.entryPath)) {
    return { ok: false, status: 403, error: 'Forbidden' }
  }

  const result = await commentStore.addComment({
    userId: req.user.userId,
    text: body.text,
    type: body.type,
    entryPath: body.entryPath,
    canopyPath: body.canopyPath,
  })

  return { ok: true, status: 201, data: result }
}

const resolveCommentHandler = async (
  gc: { branchContext: BranchContext },
  ctx: ApiContext,
  req: ApiRequest,
  params: z.infer<typeof threadParamSchema>,
): Promise<ResolveCommentResponse> => {
  const { branchContext } = gc

  const commentStore = new CommentStore(branchContext.branchRoot)
  const [thread, canRead] = await Promise.all([
    commentStore.getThread(params.threadId),
    createThreadReadCheck(ctx, req, branchContext),
  ])
  // A thread the user cannot read answers as missing, so its id does not confirm it exists.
  if (!thread || !canRead(thread.entryPath)) {
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

// Deliberately no 'writableBranch' guard on any endpoint below: comments live
// in .canopy-meta/comments.json, which is never committed to git. Commenting
// while browsing the (read-only) protected base branch is desirable.

const listComments = defineEndpoint({
  namespace: 'comments',
  name: 'list',
  method: 'GET',
  path: '/:branch/comments',
  params: branchParamSchema,
  responseType: 'CommentsResponse',
  response: {} as CommentsResponse,
  defaultMockData: { threads: [], users: [] },
  guards: ['branchAccess'] as const,
  handler: listCommentsHandler,
})

/**
 * Add a comment to a thread or create new thread
 */
const addComment = defineEndpoint({
  namespace: 'comments',
  name: 'add',
  method: 'POST',
  path: '/:branch/comments',
  params: branchParamSchema,
  body: addCommentBodySchema,
  bodyType: 'AddCommentBody',
  responseType: 'AddCommentResponse',
  response: {} as AddCommentResponse,
  defaultMockData: { threadId: 'mock-thread-id', commentId: 'mock-comment-id' },
  guards: ['branchAccess'] as const,
  handler: addCommentHandler,
})

const resolveComment = defineEndpoint({
  namespace: 'comments',
  name: 'resolve',
  method: 'POST',
  path: '/:branch/comments/:threadId/resolve',
  params: threadParamSchema,
  responseType: 'ResolveCommentResponse',
  response: {} as ResolveCommentResponse,
  defaultMockData: { resolved: true },
  guards: ['branchAccess'] as const,
  handler: resolveCommentHandler,
})

export const COMMENT_ROUTES = {
  list: listComments,
  add: addComment,
  resolve: resolveComment,
} as const
