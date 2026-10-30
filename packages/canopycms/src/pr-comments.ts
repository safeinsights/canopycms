import { CommentStore, CommentsFileMalformedError } from './comment-store'
import { getErrorMessage } from './utils/error'
import type { TaskAction } from './task-queue/cms-task-queue'
import { BranchMetadataCorruptError, readBranchMetadataFile } from './branch-metadata-file'
import {
  buildCommentsBlock,
  buildReviewBlock,
  mergeCommentsBlock,
  mergeReviewBlock,
} from './submission-attribution'

/**
 * The worker action that re-renders both blocks of a PR body that change after a submit, the
 * editor-comment summary and the review block: enqueued by api/pr-comment-sync.ts, run by
 * worker/task-runner.ts. The action string is the queue's contract.
 */
export const SYNC_PR_COMMENTS_ACTION = 'sync-pr-comments' satisfies TaskAction

/**
 * `body` with its comment summary re-rendered from `branchRoot`'s comments.json and its review
 * block from the review in branch.json as stored, or undefined when there is nothing to write.
 * The two blocks are replaced independently: a body without one still gets the other, and a
 * file that is corrupt leaves its block as it is, with a warning, without stopping the other.
 * A missing file is no failure. Any other read error, an IO fault that may pass, is thrown so
 * that the caller retries or fails visibly.
 */
export async function renderPrCommentsBody(options: {
  branchRoot: string
  branch: string
  editorUrl?: string
  body: string
  warn: (message: string) => void
}): Promise<string | undefined> {
  const original = options.body
  let next = original
  try {
    const threads = await new CommentStore(options.branchRoot).listThreadsStrict()
    next =
      mergeCommentsBlock(next, buildCommentsBlock(threads, options.branch, options.editorUrl)) ??
      next
  } catch (err) {
    if (!(err instanceof SyntaxError || err instanceof CommentsFileMalformedError)) throw err
    options.warn(
      `Could not read the editor comments of ${options.branch}; the PR keeps its summary: ${getErrorMessage(err)}`,
    )
  }
  try {
    const file = await readBranchMetadataFile(options.branchRoot)
    if (file) {
      const block = buildReviewBlock(file.branch.review, file.branch.keptOverGitHub)
      next = mergeReviewBlock(next, block) ?? next
    }
  } catch (err) {
    if (!(err instanceof BranchMetadataCorruptError)) throw err
    options.warn(
      `Could not read the review state of ${options.branch}; the PR keeps its review block: ${getErrorMessage(err)}`,
    )
  }
  return next === original ? undefined : next
}

/**
 * The in-process lock every direct-path write of a branch's PR body holds (submit and comment
 * sync), so neither writes back a body read before the other's write.
 */
export function prBodyLockKey(branchRoot: string): string {
  return `pr-body:${branchRoot}`
}

/**
 * A submit's section with its comment and review blocks re-rendered from disk, for a queued
 * submit whose blocks were rendered when it was queued: a comment or review since
 * then, or a sync task that ran while this one waited out a retry, would otherwise be
 * overwritten. The review is the one stored, as in renderPrCommentsBody: a submit clears the
 * last verdict before it writes the PR. A file that cannot be read leaves its block as it was
 * queued.
 */
export async function refreshCommentsBlock(options: {
  branchRoot: string
  branch: string
  editorUrl?: string
  section: string
  warn: (message: string) => void
}): Promise<string> {
  let section = options.section
  try {
    const threads = await new CommentStore(options.branchRoot).listThreadsStrict()
    const block = buildCommentsBlock(threads, options.branch, options.editorUrl)
    section = mergeCommentsBlock(section, block) ?? section
  } catch (err) {
    options.warn(
      `Could not re-read the editor comments of ${options.branch}; the PR gets the summary from submit time: ${getErrorMessage(err)}`,
    )
  }
  try {
    const file = await readBranchMetadataFile(options.branchRoot)
    if (file) {
      const block = buildReviewBlock(file.branch.review, file.branch.keptOverGitHub)
      section = mergeReviewBlock(section, block) ?? section
    }
  } catch (err) {
    options.warn(
      `Could not re-read the review state of ${options.branch}; the PR gets it from submit time: ${getErrorMessage(err)}`,
    )
  }
  return section
}
