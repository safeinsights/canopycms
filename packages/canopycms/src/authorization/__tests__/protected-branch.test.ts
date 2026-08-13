import { describe, expect, it } from 'vitest'

import { getBranchProtection, getBranchWriteProtection } from '../protected-branch'
import type { BranchStatus } from '../../types'

describe('getBranchProtection', () => {
  it('flags the base branch as protected+submitBlocked+readOnly in prod', () => {
    const result = getBranchProtection({ mode: 'prod', defaultBaseBranch: 'main' }, 'main')
    expect(result).toEqual({ isProtected: true, submitBlocked: true, readOnly: true })
  })

  it('flags the base branch as protected+submitBlocked but editable in dev', () => {
    const result = getBranchProtection({ mode: 'dev', defaultBaseBranch: 'main' }, 'main')
    expect(result).toEqual({ isProtected: true, submitBlocked: true, readOnly: false })
  })

  it('does not protect a non-base branch', () => {
    const result = getBranchProtection({ mode: 'prod', defaultBaseBranch: 'main' }, 'feature-x')
    expect(result).toEqual({ isProtected: false, submitBlocked: false, readOnly: false })
  })

  it('falls back to "main" when defaultBaseBranch is unset', () => {
    const result = getBranchProtection({ mode: 'prod', defaultBaseBranch: undefined }, 'main')
    expect(result).toEqual({ isProtected: true, submitBlocked: true, readOnly: true })
  })

  it('protects a non-main base branch (master)', () => {
    const result = getBranchProtection({ mode: 'prod', defaultBaseBranch: 'master' }, 'master')
    expect(result.isProtected).toBe(true)
    expect(result.readOnly).toBe(true)
  })

  it('protects a non-main base branch (develop) and leaves master unprotected', () => {
    const protectedResult = getBranchProtection(
      { mode: 'prod', defaultBaseBranch: 'develop' },
      'develop',
    )
    expect(protectedResult.isProtected).toBe(true)

    const unprotectedResult = getBranchProtection(
      { mode: 'prod', defaultBaseBranch: 'develop' },
      'master',
    )
    expect(unprotectedResult.isProtected).toBe(false)
  })

  it('treats sanitized-equivalent branch names as the same branch', () => {
    const result = getBranchProtection(
      { mode: 'prod', defaultBaseBranch: 'feature/foo' },
      'feature-foo',
    )
    expect(result.isProtected).toBe(true)
  })

  it('sanitizes both sides before comparing', () => {
    const result = getBranchProtection(
      { mode: 'dev', defaultBaseBranch: 'release/2026.07' },
      'release-2026.07',
    )
    expect(result.isProtected).toBe(true)
  })

  describe('recordedBaseBranch clause', () => {
    it('stays protected when config.defaultBaseBranch drifts but the recorded fork point equals the branch name', () => {
      const result = getBranchProtection(
        { mode: 'prod', defaultBaseBranch: 'release-1.0' },
        'main',
        'main',
      )
      expect(result.isProtected).toBe(true)
    })

    it('does not falsely protect a normal editing branch forked from the base branch', () => {
      const result = getBranchProtection(
        { mode: 'prod', defaultBaseBranch: 'main' },
        'my-feature',
        'main',
      )
      expect(result.isProtected).toBe(false)
    })

    it('is additive only -- omitting the third arg preserves prior 2-arg behavior', () => {
      const result = getBranchProtection({ mode: 'prod', defaultBaseBranch: 'main' }, 'main')
      expect(result.isProtected).toBe(true)
    })
  })

  describe('prod/dev x protected/non-protected matrix', () => {
    const cases: Array<{
      mode: 'prod' | 'dev'
      branchName: string
      isProtected: boolean
      submitBlocked: boolean
      readOnly: boolean
    }> = [
      { mode: 'prod', branchName: 'main', isProtected: true, submitBlocked: true, readOnly: true },
      {
        mode: 'prod',
        branchName: 'feature-x',
        isProtected: false,
        submitBlocked: false,
        readOnly: false,
      },
      { mode: 'dev', branchName: 'main', isProtected: true, submitBlocked: true, readOnly: false },
      {
        mode: 'dev',
        branchName: 'feature-x',
        isProtected: false,
        submitBlocked: false,
        readOnly: false,
      },
    ]

    it.each(cases)(
      'mode=$mode branch=$branchName -> $isProtected/$submitBlocked/$readOnly',
      ({ mode, branchName, isProtected, submitBlocked, readOnly }) => {
        const result = getBranchProtection({ mode, defaultBaseBranch: 'main' }, branchName)
        expect(result).toEqual({ isProtected, submitBlocked, readOnly })
      },
    )
  })

  it('does not expose writeBlocked -- that decision needs a status', () => {
    // Guards against a caller reading a `writeBlocked` that was never computed.
    expect('writeBlocked' in getBranchProtection({ mode: 'prod' }, 'feature-x')).toBe(false)
  })
})

describe('getBranchWriteProtection', () => {
  const prod = { mode: 'prod', defaultBaseBranch: 'main' } as const

  it('leaves an editing branch writable', () => {
    const result = getBranchWriteProtection(prod, 'feature-x', undefined, 'editing')
    expect(result.writeBlocked).toBe(false)
    // The status clause must never manufacture base-branch protection.
    expect(result.isProtected).toBe(false)
    expect(result.readOnly).toBe(false)
  })

  it.each(['submitted', 'approved', 'archived'] as const)(
    'blocks writes on a "%s" branch',
    (status) => {
      const result = getBranchWriteProtection(prod, 'feature-x', undefined, status)
      expect(result.writeBlocked).toBe(true)
      // submitBlocked is about the base branch, not the status lock: a
      // submitted branch is still re-submittable after a withdraw.
      expect(result.submitBlocked).toBe(false)
      expect(result.readOnly).toBe(false)
    },
  )

  // Fail-closed contract. branch.json is read with a bare cast and no schema
  // validation (branch-metadata.ts), so a hand-repaired or partially-written
  // file reaches this predicate with no status -- and corrupt branch metadata
  // is a condition this codebase already handles elsewhere (quarantine /
  // branch-health). A branch whose review state is unknown must NOT be
  // writable: allowing the write is the one outcome we can never take back.
  it('blocks writes when the status is missing at runtime', () => {
    const result = getBranchWriteProtection(
      prod,
      'feature-x',
      undefined,
      undefined as unknown as BranchStatus,
    )
    expect(result.writeBlocked).toBe(true)
    expect(result.isProtected).toBe(false)
  })

  it('blocks writes on an unrecognized status value from disk', () => {
    // Same origin as the missing-status case: unvalidated JSON can carry a
    // status this build does not know (e.g. a removed literal like 'locked',
    // or one written by a newer deployment). Anything that is not 'editing'
    // locks, so no unknown value can unlock a branch.
    const result = getBranchWriteProtection(
      prod,
      'feature-x',
      undefined,
      'locked' as unknown as BranchStatus,
    )
    expect(result.writeBlocked).toBe(true)
  })

  it('blocks writes on a submitted base branch in dev, where readOnly is false', () => {
    // Dev keeps the base branch editable, so readOnly cannot carry this --
    // without the status clause a submitted base branch stays writable in dev.
    const result = getBranchWriteProtection(
      { mode: 'dev', defaultBaseBranch: 'main' },
      'main',
      undefined,
      'submitted',
    )
    expect(result.readOnly).toBe(false)
    expect(result.writeBlocked).toBe(true)
  })

  it('keeps the base branch write-blocked in prod regardless of status', () => {
    const result = getBranchWriteProtection(prod, 'main', undefined, 'editing')
    expect(result.readOnly).toBe(true)
    expect(result.writeBlocked).toBe(true)
  })

  it('preserves the recordedBaseBranch clause it delegates', () => {
    const result = getBranchWriteProtection(
      { mode: 'prod', defaultBaseBranch: 'release-1.0' },
      'main',
      'main',
      'editing',
    )
    expect(result.isProtected).toBe(true)
    expect(result.writeBlocked).toBe(true)
  })

  describe('submitBlockedIncludingStatus', () => {
    // The compound submit rule: base-branch protection OR a non-'editing'
    // status. Consumed as-is by BranchManager.tsx's canSubmit and emitted on
    // the wire as BranchListItem.submitBlocked (api/branch.ts) -- neither
    // side should re-derive either half locally.

    it('is true for a submitted, unprotected branch', () => {
      const result = getBranchWriteProtection(prod, 'feature-x', undefined, 'submitted')
      expect(result.submitBlockedIncludingStatus).toBe(true)
      // Confirms this really is the STATUS half doing the work here, not the
      // base-branch half leaking in.
      expect(result.submitBlocked).toBe(false)
    })

    it('is true for the base branch, even while editing', () => {
      const result = getBranchWriteProtection(prod, 'main', undefined, 'editing')
      expect(result.submitBlockedIncludingStatus).toBe(true)
      expect(result.submitBlocked).toBe(true)
    })

    it('is false only for an editing, unprotected branch', () => {
      const result = getBranchWriteProtection(prod, 'feature-x', undefined, 'editing')
      expect(result.submitBlockedIncludingStatus).toBe(false)
    })

    it('fails closed when status is unreadable, same as writeBlocked', () => {
      const result = getBranchWriteProtection(
        prod,
        'feature-x',
        undefined,
        undefined as unknown as BranchStatus,
      )
      expect(result.submitBlockedIncludingStatus).toBe(true)
    })

    // The asymmetry that justifies having two separate compound fields
    // instead of one: in dev mode the base branch is WRITABLE (readOnly is
    // false there, so writeBlocked can be false) but never SUBMITTABLE
    // (isProtected/submitBlocked are mode-independent). A future "these look
    // redundant, merge writeBlocked and submitBlockedIncludingStatus" refactor
    // would break exactly this case.
    it('stays submit-blocked on the dev-mode base branch even though writes are allowed there', () => {
      const dev = { mode: 'dev', defaultBaseBranch: 'main' } as const
      const result = getBranchWriteProtection(dev, 'main', undefined, 'editing')
      expect(result.readOnly).toBe(false)
      expect(result.writeBlocked).toBe(false)
      expect(result.submitBlockedIncludingStatus).toBe(true)
    })
  })
})
