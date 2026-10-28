import { CommentStore } from './comment-store'
import type { TaskAction } from './task-queue/cms-task-queue'
import { buildCommentsBlock, mergeCommentsBlock } from './submission-attribution'

/**
 * The worker action that re-renders a PR's editor-comment summary: enqueued by
 * api/pr-comment-sync.ts, run by worker/task-runner.ts.
 */
export const SYNC_PR_COMMENTS_ACTION = 'sync-pr-comments' satisfies TaskAction

/**
 * `body` with its comment summary re-rendered from `branchRoot`'s comments.json, or undefined
 * when there is nothing to write: no summary block to replace, or no change.
 */
export async function renderPrCommentsBody(options: {
  branchRoot: string
  branch: string
  editorUrl?: string
  body: string | null | undefined
}): Promise<string | undefined> {
  const threads = await new CommentStore(options.branchRoot).listThreads({ includeResolved: true })
  const next = mergeCommentsBlock(
    options.body,
    buildCommentsBlock(threads, options.branch, options.editorUrl),
  )
  return next === undefined || next === options.body ? undefined : next
}
