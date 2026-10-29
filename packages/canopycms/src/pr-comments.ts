import { CommentStore } from './comment-store'
import { getErrorMessage } from './utils/error'
import type { TaskAction } from './task-queue/cms-task-queue'
import {
  BranchMetadataCorruptError,
  readBranchMetadataFile,
  type BranchMetadataFile,
} from './branch-metadata-file'
import {
  buildCommentsBlock,
  buildReviewBlock,
  mergeCommentsBlock,
  mergeReviewBlock,
} from './submission-attribution'

/**
 * The worker action that re-renders the blocks of a PR body that change after a submit, the
 * editor-comment summary and the review state: enqueued by api/pr-comment-sync.ts, run by
 * worker/task-runner.ts.
 */
export const SYNC_PR_COMMENTS_ACTION = 'sync-pr-comments' satisfies TaskAction

/**
 * `branchRoot`'s branch.json, or undefined when it is missing or corrupt: the review block then
 * stays as it is, as a PR is not worth a wrong verdict. Any other IO failure is thrown.
 */
async function readBranchFile(branchRoot: string): Promise<BranchMetadataFile | undefined> {
  try {
    return (await readBranchMetadataFile(branchRoot)) ?? undefined
  } catch (err) {
    if (err instanceof BranchMetadataCorruptError) return undefined
    throw err
  }
}

/**
 * `body` with its comment summary re-rendered from `branchRoot`'s comments.json and its review
 * block from the review in branch.json as stored, or undefined when there is nothing to write.
 * The two blocks are replaced independently: a body without one still gets the other.
 */
export async function renderPrCommentsBody(options: {
  branchRoot: string
  branch: string
  editorUrl?: string
  body: string | null | undefined
}): Promise<string | undefined> {
  const threads = await new CommentStore(options.branchRoot).listThreadsStrict()
  const file = await readBranchFile(options.branchRoot)
  const original = options.body ?? ''
  let next = original
  next =
    mergeCommentsBlock(next, buildCommentsBlock(threads, options.branch, options.editorUrl)) ?? next
  if (file) next = mergeReviewBlock(next, buildReviewBlock(file.branch.review)) ?? next
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
 * submit whose blocks were rendered when it was queued: a comment or review since then, or a
 * sync task that ran while this one waited out a retry, would otherwise be overwritten. The
 * review counts only while the branch is in review: before the submit is saved the branch is
 * still `editing`, and its last round's verdict is not this PR's. A file that cannot be read
 * leaves its block as it was queued.
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
    const file = await readBranchFile(options.branchRoot)
    if (file) {
      const { status, review } = file.branch
      const inReview = status === 'submitted' || status === 'approved'
      section =
        mergeReviewBlock(section, buildReviewBlock(inReview ? review : undefined)) ?? section
    }
  } catch (err) {
    options.warn(
      `Could not re-read the review state of ${options.branch}; the PR gets it from submit time: ${getErrorMessage(err)}`,
    )
  }
  return section
}
