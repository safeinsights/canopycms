import type { SimpleGit } from 'simple-git'

import { BranchMetadataFileManager } from '../branch-metadata'
import { commitsApart } from './branch-merge'

/**
 * What the worker may publish for a branch: move its head in `remote.git`, which is all a GitHub
 * push ever sends (task-runner.ts `pushBranchToGitHub`). Work the author has saved but not
 * submitted reaches neither until their submit pushes it, so a commit the worker builds on top of
 * such work stays in the clone. The worker publishes in two places, and each asks here or follows
 * the rule stated here:
 *
 * - a merge it built (github-commits.ts `mergeIntoBranch`): {@link decidePublish};
 * - a rewrite of history already published (history-rewrite.ts): only the rebased tip recorded with
 *   the rewrite, never the clone's current head, which can carry a commit made since.
 */
export type PublishDecision =
  /** `remote.git` has no head for the branch: nothing of it was ever published. */
  | { kind: 'never-published' }
  /** Nothing in the merge is work the author has yet to submit. */
  | { kind: 'publish' }
  /** The branch's side holds commits the author has not submitted: the merge stays in the clone. */
  | { kind: 'hold' }

/**
 * Whether a merge built on `head` may be published over `published`, `remote.git`'s head. A branch
 * in review may: its clone holds only what was submitted, as saving and getting the latest changes
 * both wait for a withdraw. Any other branch may only when `remote.git` already holds all of
 * `head`. Judged afresh every time, under the caller's content-write lock, so nothing records a
 * hold: the next submit pushes the clone, held merges included, as a fast-forward. The caller has
 * checked that the clone holds `published`.
 */
export async function decidePublish(
  git: SimpleGit,
  { branchPath, head, published }: { branchPath: string; head: string; published: string | null },
): Promise<PublishDecision> {
  if (published === null) return { kind: 'never-published' }
  if (published === head) return { kind: 'publish' }
  const status = (await BranchMetadataFileManager.loadOnly(branchPath))?.branch.status
  if (status === 'submitted' || status === 'approved') return { kind: 'publish' }
  const { onlyA } = await commitsApart(git, head, published)
  return onlyA === 0 ? { kind: 'publish' } : { kind: 'hold' }
}
