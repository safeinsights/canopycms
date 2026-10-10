import { describe, expect, it } from 'vitest'
import {
  BRANCH_STATUS_PRESENTATION,
  PROTECTED_BRANCH_PRESENTATION,
  branchStatusPresentation,
} from './branch-status'

describe('branchStatusPresentation', () => {
  it.each([
    ['editing', 'Editing', 'brand'],
    ['submitted', 'In review', 'green'],
    ['approved', 'Approved', 'teal'],
    ['archived', 'Archived', 'gray'],
  ] as const)('presents %s as "%s"', (status, label, color) => {
    expect(branchStatusPresentation(status)).toEqual({ label, color, variant: 'light' })
    expect(BRANCH_STATUS_PRESENTATION[status].label).toBe(label)
  })

  it('shows Protected for the protected base branch whatever its status', () => {
    expect(branchStatusPresentation('submitted', true)).toBe(PROTECTED_BRANCH_PRESENTATION)
    expect(branchStatusPresentation('editing', true)?.label).toBe('Protected')
    expect(branchStatusPresentation(undefined, true)?.label).toBe('Protected')
  })

  it('shows an unrecognised status as itself, neutrally', () => {
    expect(branchStatusPresentation('quarantined')).toEqual({
      label: 'quarantined',
      color: 'gray',
      variant: 'light',
    })
    // Object.prototype keys are not statuses.
    expect(branchStatusPresentation('constructor')?.label).toBe('constructor')
  })

  it('returns undefined when there is no status and the branch is not protected', () => {
    expect(branchStatusPresentation(undefined)).toBeUndefined()
    expect(branchStatusPresentation('')).toBeUndefined()
  })
})
