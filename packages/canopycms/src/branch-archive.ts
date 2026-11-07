import type { BranchMetadata } from './types'

type ArchiveFields = Pick<
  BranchMetadata,
  | 'status'
  | 'archivedAt'
  | 'mergedAt'
  | 'unpublishedAtMerge'
  | 'gitHubTipAtArchive'
  | 'lastGitHubTip'
>

/** When the branch was archived, or undefined for one that records neither time. */
export const archivedTime = (branch: ArchiveFields): number | undefined => {
  const recorded = branch.archivedAt ?? branch.mergedAt
  if (recorded === undefined) return undefined
  const time = Date.parse(recorded)
  return Number.isNaN(time) ? undefined : time
}

/** Archived before `cutoffMs`. `updatedAt` is no clock: any metadata write moves it. */
export const archivedBefore = (branch: ArchiveFields, cutoffMs: number): boolean => {
  const time = archivedTime(branch)
  return branch.status === 'archived' && time !== undefined && time < cutoffMs
}

/** Why deletion by age leaves a branch for a person to delete. */
export type AgeDeletionHold = 'not-merged' | 'unpublished' | 'moved-on-github'

/**
 * What keeps a branch from deletion by age, past any age. One archived without merging holds work
 * that reached no base branch. One merged with an unfinished submit may hold the only copy of
 * commits the merge left out, and deleting it would drop the alert that says so. One whose GitHub
 * branch took commits after the merge would lose them to the GitHub delete.
 */
export const ageDeletionHold = (branch: ArchiveFields): AgeDeletionHold | undefined =>
  branch.mergedAt === undefined
    ? 'not-merged'
    : branch.unpublishedAtMerge === true
      ? 'unpublished'
      : branch.gitHubTipAtArchive !== undefined &&
          branch.lastGitHubTip !== branch.gitHubTipAtArchive
        ? 'moved-on-github'
        : undefined

/** The one rule the retention sweep and the admin bulk delete both select by. */
export const deletableByAge = (branch: ArchiveFields, cutoffMs: number): boolean =>
  archivedBefore(branch, cutoffMs) && ageDeletionHold(branch) === undefined

/** `now` less `days`, as the cutoff the functions above take. */
export const archivedCutoff = (days: number, now: number): number => now - days * 24 * 60 * 60_000
