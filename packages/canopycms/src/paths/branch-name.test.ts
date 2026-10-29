import { describe, expect, it } from 'vitest'

import { CMS_BRANCH_PREFIX, cmsBranchName } from './branch-name'

describe('cmsBranchName', () => {
  it.each([
    ['spring', 'canopycms-spring'],
    ['feature/x', 'canopycms-feature-x'],
    ['Spring-Update', 'canopycms-Spring-Update'],
    // Already in the namespace: never doubled, before or after sanitizing.
    ['canopycms-spring', 'canopycms-spring'],
    ['canopycms/spring', 'canopycms-spring'],
    // A prefix that differs in case is not the prefix.
    ['CanopyCMS-spring', 'canopycms-CanopyCMS-spring'],
    // Sanitizing can leave a leading '-', which the prefix's own '-' absorbs.
    ['@spring', 'canopycms-spring'],
    ['canopycms', 'canopycms-canopycms'],
  ])('creates %s as %s', (typed, created) => {
    expect(cmsBranchName(typed)).toBe(created)
    expect(cmsBranchName(created)).toBe(created)
    expect(created.startsWith(CMS_BRANCH_PREFIX)).toBe(true)
  })
})
