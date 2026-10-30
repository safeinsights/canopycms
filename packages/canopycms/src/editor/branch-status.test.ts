import { describe, expect, it } from 'vitest'
import {
  BRANCH_STATUS_PRESENTATION,
  PROTECTED_BRANCH_PRESENTATION,
  branchHoldMessage,
  branchStatusPresentation,
} from './branch-status'

describe('branchHoldMessage', () => {
  const author = { role: 'withdraw', isAdmin: false } as const

  it('shows a base from GitHub as exactly what it is', () => {
    expect(branchHoldMessage({ kind: 'retargeted', base: 'evil\u202Ename' }, author)).toContain(
      'evil\\u{202e}name',
    )
  })

  it('offers each viewer a way forward they can take on a conflict', () => {
    const hold = { kind: 'conflicts' } as const
    expect(branchHoldMessage(hold, author)).toContain('Use "Withdraw from review"')
    const reviewer = branchHoldMessage(hold, { role: 'review', isAdmin: false })
    expect(reviewer).toContain('Request changes')
    expect(reviewer).not.toContain('Withdraw')
    expect(branchHoldMessage(hold, { role: 'none', isAdmin: false })).toContain(
      'Its editor needs to withdraw it',
    )
  })

  it('points only an admin at System health, which nobody else can open', () => {
    const hold = { kind: 'rewritten' } as const
    expect(branchHoldMessage(hold, author)).toContain('Ask an admin')
    expect(branchHoldMessage(hold, author)).not.toContain('System health')
    expect(branchHoldMessage(hold, { role: 'none', isAdmin: true })).toContain('"System health"')
  })
})

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
