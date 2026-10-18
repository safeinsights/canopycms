import { describe, expect, it } from 'vitest'
import type { BranchStatus } from '../types'
import { branchBarStatus, branchLockState, describeBranchLock } from './branch-lock'
import type { BranchBarStatusInput } from './branch-lock'

const input = (overrides: Partial<BranchBarStatusInput> = {}): BranchBarStatusInput => ({
  branchStatus: 'editing',
  isProtected: false,
  ...overrides,
})

describe('branchLockState', () => {
  it.each([
    [{ branchStatus: 'editing' as const }, false, false, false],
    [{ branchStatus: 'editing' as const, branchReadOnly: true }, true, false, false],
    [{ branchStatus: 'submitted' as const, branchWriteBlocked: true }, false, true, false],
    [{ branchStatus: undefined, branchWriteBlocked: true }, false, true, true],
    [{ branchStatus: 'editing' as const, branchWriteBlocked: true }, false, true, true],
    [
      { branchStatus: 'submitted' as const, branchReadOnly: true, branchWriteBlocked: true },
      true,
      false,
      false,
    ],
  ])('reads %j as readOnly %s, statusLocked %s, unavailable %s', (lock, ro, locked, gone) => {
    expect(branchLockState(lock)).toEqual({
      readOnly: ro,
      statusLocked: locked,
      branchDataUnavailable: gone,
    })
  })
})

describe('branchBarStatus', () => {
  it.each<[string, Partial<BranchBarStatusInput>, string | undefined, string | undefined]>([
    ['an editable branch', {}, undefined, undefined],
    [
      'a fetch in flight',
      { branchStatus: undefined, branchWriteBlocked: true, branchPending: true },
      'Loading branch…',
      undefined,
    ],
    [
      'a failed fetch',
      { branchStatus: undefined, branchWriteBlocked: true },
      'Details unavailable · read-only',
      'switchBranch',
    ],
    [
      'version skew: locked while "editing"',
      { branchWriteBlocked: true },
      'Details unavailable · read-only',
      'switchBranch',
    ],
    [
      'the protected base branch in prod',
      { branchReadOnly: true, branchWriteBlocked: true, isProtected: true },
      'Protected · read-only',
      'newBranch',
    ],
    ['a protected branch that takes writes', { isProtected: true }, 'Protected', undefined],
    [
      'a branch in review',
      { branchStatus: 'submitted', branchWriteBlocked: true },
      'In review · read-only',
      'workflow',
    ],
    [
      'an approved branch',
      { branchStatus: 'approved', branchWriteBlocked: true },
      'Approved · read-only',
      'workflow',
    ],
    [
      'an archived branch',
      { branchStatus: 'archived', branchWriteBlocked: true },
      'Archived · read-only',
      'switchBranch',
    ],
    [
      'a status this editor does not know',
      { branchStatus: 'merged' as BranchStatus, branchWriteBlocked: true },
      'Merged · read-only',
      'switchBranch',
    ],
  ])('gives %s its row', (_label, overrides, label, action) => {
    const status = branchBarStatus(input(overrides))
    expect(status.label).toBe(label)
    expect(status.action).toBe(action)
  })

  it('checks a pending fetch before unavailable data, which a fetch in flight also is', () => {
    const lock = { branchStatus: undefined, branchWriteBlocked: true }
    expect(branchLockState(lock).branchDataUnavailable).toBe(true)
    expect(branchBarStatus(input({ ...lock, branchPending: true })).label).toBe('Loading branch…')
  })

  it('names the read-only base branch, not its review, when both apply', () => {
    const status = branchBarStatus(
      input({
        branchStatus: 'submitted',
        branchReadOnly: true,
        branchWriteBlocked: true,
        isProtected: true,
      }),
    )
    expect(status.label).toBe('Protected · read-only')
    expect(status.action).toBe('newBranch')
  })

  it('names a status lock on a protected branch that otherwise takes writes', () => {
    const status = branchBarStatus(
      input({ branchStatus: 'submitted', branchWriteBlocked: true, isProtected: true }),
    )
    expect(status.label).toBe('In review · read-only')
  })

  it('names no protection the server did not report', () => {
    expect(branchBarStatus(input({ isProtected: undefined })).label).toBeUndefined()
  })

  it('marks exactly the locked rows read-only', () => {
    expect(branchBarStatus(input({ isProtected: true })).readOnly).toBe(false)
    expect(
      branchBarStatus(
        input({ branchStatus: undefined, branchWriteBlocked: true, branchPending: true }),
      ).readOnly,
    ).toBe(false)
    expect(
      branchBarStatus(input({ branchStatus: 'archived', branchWriteBlocked: true })).readOnly,
    ).toBe(true)
  })
})

describe('describeBranchLock', () => {
  it('gives a reason exactly when the branch takes no writes', () => {
    expect(describeBranchLock({ branchStatus: 'editing' })).toBeUndefined()
    expect(describeBranchLock({ branchStatus: 'submitted', branchWriteBlocked: true })).toBe(
      'This branch is in review. Withdraw it to make changes.',
    )
    expect(describeBranchLock({ branchStatus: undefined, branchWriteBlocked: true })).toMatch(
      /could not be loaded/,
    )
    expect(
      describeBranchLock({
        branchStatus: undefined,
        branchWriteBlocked: true,
        branchPending: true,
      }),
    ).toBe('Wait for the branch details to load.')
    expect(describeBranchLock({ branchStatus: 'editing', branchReadOnly: true })).toBe(
      'The base branch is read-only. Create a branch to make changes.',
    )
  })
})
