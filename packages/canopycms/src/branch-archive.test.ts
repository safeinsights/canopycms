import { describe, expect, it } from 'vitest'

import {
  ageDeletionHold,
  archivedBefore,
  archivedCutoff,
  archivedTime,
  deletableByAge,
} from './branch-archive'

const NOW = Date.parse('2026-06-01T00:00:00.000Z')
const OLD = '2026-01-01T00:00:00.000Z'
const RECENT = '2026-05-31T00:00:00.000Z'
const cutoff = archivedCutoff(30, NOW)

describe('branch-archive', () => {
  it('counts the cutoff back from now in whole days', () => {
    expect(archivedCutoff(2, NOW)).toBe(NOW - 172_800_000)
  })

  it('prefers archivedAt and falls back to mergedAt', () => {
    expect(archivedTime({ status: 'archived', archivedAt: RECENT, mergedAt: OLD })).toBe(
      Date.parse(RECENT),
    )
    expect(archivedTime({ status: 'archived', mergedAt: OLD })).toBe(Date.parse(OLD))
  })

  it('selects a merged, archived branch past the cutoff', () => {
    expect(deletableByAge({ status: 'archived', archivedAt: OLD, mergedAt: OLD }, cutoff)).toBe(
      true,
    )
    expect(deletableByAge({ status: 'archived', mergedAt: OLD }, cutoff)).toBe(true)
  })

  it('leaves one archived after the cutoff', () => {
    expect(deletableByAge({ status: 'archived', archivedAt: RECENT, mergedAt: OLD }, cutoff)).toBe(
      false,
    )
  })

  it('never selects a branch archived without merging, however old', () => {
    const unmerged = { status: 'archived', archivedAt: OLD } as const
    expect(archivedBefore(unmerged, cutoff)).toBe(true)
    expect(ageDeletionHold(unmerged)).toBe('not-merged')
    expect(deletableByAge(unmerged, cutoff)).toBe(false)
  })

  it.each(['editing', 'submitted', 'approved'] as const)('never selects a %s branch', (status) => {
    expect(deletableByAge({ status, archivedAt: OLD, mergedAt: OLD }, cutoff)).toBe(false)
  })

  it('never selects a branch with no readable archive time', () => {
    expect(deletableByAge({ status: 'archived' }, cutoff)).toBe(false)
    expect(deletableByAge({ status: 'archived', mergedAt: 'not a date' }, cutoff)).toBe(false)
  })

  it('holds a branch rewritten on GitHub back from deletion by age', () => {
    const rewritten = { status: 'archived', mergedAt: OLD, rewrittenOnGitHub: 'abc' } as const
    expect(ageDeletionHold(rewritten)).toBe('unpublished')
    expect(deletableByAge(rewritten, cutoff)).toBe(false)
  })

  it('holds a branch that may have unpublished commits back from deletion by age', () => {
    const held = { status: 'archived', mergedAt: OLD, unpublishedAtMerge: true } as const
    expect(ageDeletionHold(held)).toBe('unpublished')
    expect(archivedBefore(held, cutoff)).toBe(true)
    expect(deletableByAge(held, cutoff)).toBe(false)
  })
})
