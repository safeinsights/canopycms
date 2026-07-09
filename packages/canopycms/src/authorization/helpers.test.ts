import { describe, expect, it } from 'vitest'

import {
  RESERVED_GROUPS,
  isAdmin,
  isPrivileged,
  isReservedGroup,
  isReviewer,
  stripReservedGroups,
} from './helpers'

describe('isReservedGroup', () => {
  it('recognizes both reserved IDs', () => {
    expect(isReservedGroup(RESERVED_GROUPS.ADMINS)).toBe(true)
    expect(isReservedGroup(RESERVED_GROUPS.REVIEWERS)).toBe(true)
  })

  it('rejects non-reserved IDs, including case variants', () => {
    expect(isReservedGroup('team-a')).toBe(false)
    expect(isReservedGroup('admins')).toBe(false)
    expect(isReservedGroup('ADMINS')).toBe(false)
    expect(isReservedGroup('')).toBe(false)
  })
})

describe('stripReservedGroups', () => {
  it('removes every reserved privileged ID', () => {
    const stripped = stripReservedGroups([RESERVED_GROUPS.ADMINS, RESERVED_GROUPS.REVIEWERS])
    expect(stripped).toEqual([])
  })

  it('preserves ordinary groups and their order', () => {
    const stripped = stripReservedGroups([
      'team-a',
      RESERVED_GROUPS.ADMINS,
      'team-b',
      RESERVED_GROUPS.REVIEWERS,
      'team-c',
    ])
    expect(stripped).toEqual(['team-a', 'team-b', 'team-c'])
  })

  it('leaves stripped output unable to satisfy privilege checks', () => {
    const stripped = stripReservedGroups([RESERVED_GROUPS.ADMINS, RESERVED_GROUPS.REVIEWERS])
    expect(isAdmin(stripped)).toBe(false)
    expect(isReviewer(stripped)).toBe(false)
    expect(isPrivileged(stripped)).toBe(false)
  })

  it('does not over-strip case variants that confer no privilege', () => {
    const stripped = stripReservedGroups(['admins', 'reviewers'])
    expect(stripped).toEqual(['admins', 'reviewers'])
    expect(isAdmin(stripped)).toBe(false)
    expect(isReviewer(stripped)).toBe(false)
  })

  it('handles an empty list', () => {
    expect(stripReservedGroups([])).toEqual([])
  })
})

describe('isAdmin / isReviewer / isPrivileged', () => {
  it('grants admin only via the Admins group', () => {
    expect(isAdmin([RESERVED_GROUPS.ADMINS])).toBe(true)
    expect(isAdmin([RESERVED_GROUPS.REVIEWERS])).toBe(false)
    expect(isAdmin(['team-a'])).toBe(false)
    expect(isAdmin([])).toBe(false)
    expect(isAdmin(undefined)).toBe(false)
  })

  it('grants reviewer via Reviewers or Admins', () => {
    expect(isReviewer([RESERVED_GROUPS.REVIEWERS])).toBe(true)
    expect(isReviewer([RESERVED_GROUPS.ADMINS])).toBe(true)
    expect(isReviewer(['team-a'])).toBe(false)
    expect(isReviewer(undefined)).toBe(false)
  })

  it('isPrivileged mirrors isReviewer', () => {
    expect(isPrivileged([RESERVED_GROUPS.REVIEWERS])).toBe(true)
    expect(isPrivileged([RESERVED_GROUPS.ADMINS])).toBe(true)
    expect(isPrivileged(['team-a'])).toBe(false)
    expect(isPrivileged(undefined)).toBe(false)
  })
})
