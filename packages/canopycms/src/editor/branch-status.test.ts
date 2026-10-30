import { describe, expect, it } from 'vitest'
import {
  BRANCH_STATUS_PRESENTATION,
  PROTECTED_BRANCH_PRESENTATION,
  branchHoldMessage,
  branchStatusPresentation,
  syncFailedFallback,
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
    expect(reviewer).toContain('Use "Request changes"')
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

  it('names the fix in System health, which it would otherwise send an admin back to', () => {
    const line = branchHoldMessage(
      { kind: 'rewritten' },
      { role: 'none', isAdmin: true, inSystemHealth: true },
    )
    expect(line).toContain('merge the missing commit back')
    expect(line).not.toContain('"System health"')
  })

  it('tells only a non-admin to ask an admin about a retargeted pull request', () => {
    const hold = { kind: 'retargeted', base: 'release' } as const
    expect(branchHoldMessage(hold, author)).toContain('or ask an admin')
    expect(branchHoldMessage(hold, { role: 'none', isAdmin: true })).toMatch(
      /Update it on the pull request\.$/,
    )
  })
})

describe('syncFailedFallback', () => {
  it('sends only an admin to System health', () => {
    expect(syncFailedFallback({ isAdmin: true, held: false })).toContain(
      'the "Tasks" tab in "System health"',
    )
    const editor = syncFailedFallback({ isAdmin: false, held: false })
    expect(editor).toBe('GitHub sync failed. Ask an admin to retry it.')
  })

  it('leaves the way forward to a hold beside it', () => {
    expect(syncFailedFallback({ isAdmin: true, held: true })).toBe('GitHub sync failed.')
    expect(syncFailedFallback({ isAdmin: false, held: true })).toBe('GitHub sync failed.')
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
