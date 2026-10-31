import { describe, expect, it } from 'vitest'
import {
  BRANCH_STATUS_PRESENTATION,
  PROTECTED_BRANCH_PRESENTATION,
  branchHoldMessage,
  branchStatusPresentation,
  endSentence,
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

describe('a submit that never finished', () => {
  const hold = { kind: 'submit-unfinished', opened: true } as const

  it('says what the pull request may be missing, for anyone', () => {
    const line = branchHoldMessage(hold, { role: 'none', isAdmin: false })
    expect(line).toContain('may not have its latest changes')
    expect(line).toContain('Ask an admin to retry the submit.')
    expect(line).not.toContain('Withdraw')
  })

  it('says no pull request was opened when none was', () => {
    const line = branchHoldMessage(
      { kind: 'submit-unfinished', opened: false },
      { role: 'none', isAdmin: false },
    )
    expect(line).toContain("its pull request wasn't opened")
    expect(line).not.toContain('latest changes')
  })

  it('offers its editor the way out that needs no admin, and no failed task', () => {
    expect(branchHoldMessage(hold, { role: 'withdraw', isAdmin: false })).toContain(
      'Ask an admin to retry the submit, or use "Withdraw from review", then submit the branch again.',
    )
  })

  it('offers a reviewer the way out they have', () => {
    expect(branchHoldMessage(hold, { role: 'review', isAdmin: false })).toContain(
      'Ask an admin to retry the submit, or use "Request changes" to send it back to its editor.',
    )
  })

  describe('with no task behind it', () => {
    const notQueued = { ...hold, notQueued: true }

    it('offers nobody a retry, there being no task to retry', () => {
      for (const role of ['withdraw', 'review', 'none'] as const) {
        for (const isAdmin of [false, true]) {
          expect(branchHoldMessage(notQueued, { role, isAdmin })).not.toMatch(/retry|Tasks/i)
        }
      }
    })

    it('gives each role the way forward it has', () => {
      expect(branchHoldMessage(notQueued, { role: 'withdraw', isAdmin: false })).toContain(
        'Use "Withdraw from review", then submit the branch again.',
      )
      expect(branchHoldMessage(notQueued, { role: 'review', isAdmin: false })).toContain(
        'Use "Request changes" to send it back to its editor.',
      )
      expect(branchHoldMessage(notQueued, { role: 'none', isAdmin: true })).toContain(
        'Its editor needs to withdraw it from review and submit it again.',
      )
    })
  })

  it('sends an admin to the task, naming the panel only outside it', () => {
    expect(branchHoldMessage(hold, { role: 'none', isAdmin: true })).toContain(
      'Retry the submit from the "Tasks" tab in "System health".',
    )
    expect(branchHoldMessage(hold, { role: 'none', isAdmin: true, inSystemHealth: true })).toMatch(
      /Retry the submit from the "Tasks" tab\.$/,
    )
  })
})

describe('a branch merged before its submit finished', () => {
  const hold = { kind: 'unpublished-at-merge' } as const

  it('tells an editor who can check it, and an admin where', () => {
    expect(branchHoldMessage(hold, { role: 'none', isAdmin: false })).toContain(
      'Ask an admin to check it.',
    )
    expect(branchHoldMessage(hold, { role: 'none', isAdmin: true })).toContain(
      'the "Overview" tab in "System health"',
    )
  })

  it('never sends System health to itself', () => {
    expect(
      branchHoldMessage(hold, { role: 'none', isAdmin: true, inSystemHealth: true }),
    ).not.toContain('"System health"')
  })
})

describe('endSentence', () => {
  it.each([
    ['It has moved on GitHub', 'It has moved on GitHub.'],
    ['It has moved.', 'It has moved.'],
    ['Push failed for "x".\n', 'Push failed for "x".'],
    ['It timed out (after 5s.)', 'It timed out (after 5s.)'],
    ['remote:', 'remote:'],
  ])('ends %j once', (text, ended) => {
    expect(endSentence(text)).toBe(ended)
  })
})

describe('syncFailedFallback', () => {
  it('sends only an admin to System health', () => {
    expect(syncFailedFallback(true)).toContain('the "Tasks" tab in "System health"')
    expect(syncFailedFallback(false)).toBe('GitHub sync failed. Ask an admin to retry it.')
  })

  it('offers no retry on an archived branch, which has nothing left to finish', () => {
    expect(syncFailedFallback(true, 'archived')).toBe('GitHub sync failed.')
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
