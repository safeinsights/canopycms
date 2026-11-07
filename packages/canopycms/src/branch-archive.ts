import type { BranchMetadata } from './types'

type ArchiveFields = Pick<
  BranchMetadata,
  'status' | 'archivedAt' | 'mergedAt' | 'unpublishedAtMerge' | 'rewrittenOnGitHub'
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
export type AgeDeletionHold = 'not-merged' | 'unpublished'

/**
 * What keeps a branch from deletion by age, past any age: one archived without merging holds work
 * that reached no base branch, and one merged with an unfinished submit, or rewritten on GitHub,
 * may hold the only copy of commits the merge left out. Nothing warns of a rewrite once a branch
 * is archived, so this hold is the only thing standing between those commits and the sweep.
 */
export const ageDeletionHold = (branch: ArchiveFields): AgeDeletionHold | undefined =>
  branch.mergedAt === undefined
    ? 'not-merged'
    : branch.unpublishedAtMerge === true || branch.rewrittenOnGitHub !== undefined
      ? 'unpublished'
      : undefined

/** The one rule the retention sweep and the admin bulk delete both select by. */
export const deletableByAge = (branch: ArchiveFields, cutoffMs: number): boolean =>
  archivedBefore(branch, cutoffMs) && ageDeletionHold(branch) === undefined

/** `now` less `days`, as the cutoff the functions above take. */
export const archivedCutoff = (days: number, now: number): number => now - days * 24 * 60 * 60_000
