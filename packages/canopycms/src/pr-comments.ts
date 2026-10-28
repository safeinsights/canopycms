import { CommentStore } from './comment-store'
import { getErrorMessage } from './utils/error'
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
  const threads = await new CommentStore(options.branchRoot).listThreadsStrict()
  const next = mergeCommentsBlock(
    options.body,
    buildCommentsBlock(threads, options.branch, options.editorUrl),
  )
  return next === undefined || next === options.body ? undefined : next
}

/**
 * The in-process lock every direct-path write of a branch's PR body holds (submit and comment
 * sync), so neither writes back a body read before the other's write.
 */
export function prBodyLockKey(branchRoot: string): string {
  return `pr-body:${branchRoot}`
}

/**
 * A submit's section with its comment block re-rendered from comments.json, for a queued submit
 * whose block was rendered when it was queued: a comment change since then, or a sync task that
 * ran while this one waited out a retry, would otherwise be overwritten. If comments.json cannot
 * be read, the section keeps the block it was queued with.
 */
export async function refreshCommentsBlock(options: {
  branchRoot: string
  branch: string
  editorUrl?: string
  section: string
  warn: (message: string) => void
}): Promise<string> {
  try {
    const threads = await new CommentStore(options.branchRoot).listThreadsStrict()
    const block = buildCommentsBlock(threads, options.branch, options.editorUrl)
    return mergeCommentsBlock(options.section, block) ?? options.section
  } catch (err) {
    options.warn(
      `Could not re-read the editor comments of ${options.branch}; the PR gets the summary from submit time: ${getErrorMessage(err)}`,
    )
    return options.section
  }
}
