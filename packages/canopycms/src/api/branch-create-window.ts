/**
 * How long a create of a branch name its own creator just made answers with that branch rather
 * than a 409, so a request killed between publishing the branch and responding is safe to retry.
 * Dependency-free: the editor applies the same rule when it settles an unanswered create.
 * @internal Exported for tests.
 */
export const IDEMPOTENT_CREATE_WINDOW_MS = 5 * 60_000

/** Whether `branch` can be the result of `userId`'s create: theirs, and inside the window. */
export function isCreatorsRecentBranch(
  branch: { createdBy: string; createdAt: string },
  userId: string | undefined,
): boolean {
  return (
    userId !== undefined &&
    branch.createdBy === userId &&
    Date.now() - Date.parse(branch.createdAt) < IDEMPOTENT_CREATE_WINDOW_MS
  )
}
