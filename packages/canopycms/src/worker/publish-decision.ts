import type { SimpleGit } from 'simple-git'

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
 *   the rewrite, never the clone's current head, which can carry a commit made since. While that
 *   tip is unpublished the branch takes nothing in (rebase.ts), so nothing is built on it.
 */
export type PublishDecision =
  /** `remote.git` has no head for the branch: nothing of it was ever published. */
  | { kind: 'never-published' }
  /** Every commit on the branch's side is already in `remote.git`'s head. */
  | { kind: 'publish' }
  /** The branch's side holds commits the author has not submitted: the merge stays in the clone. */
  | { kind: 'hold' }

/**
 * Whether a merge built on `head` may be published over `published`, `remote.git`'s head: only
 * when `remote.git` already holds all of `head`, whatever the branch's status, since a save can be
 * committed in the moment between a submit's push and its status write. Judged from the commits
 * every time, so nothing records a hold: the next submit pushes the clone, held merges included,
 * as a fast-forward. The caller has checked that the clone holds `published`.
 */
export async function decidePublish(
  git: SimpleGit,
  { head, published }: { head: string; published: string | null },
): Promise<PublishDecision> {
  if (published === null) return { kind: 'never-published' }
  if (published === head) return { kind: 'publish' }
  const { onlyA } = await commitsApart(git, head, published)
  return onlyA === 0 ? { kind: 'publish' } : { kind: 'hold' }
}
