import { describe, expect, it } from 'vitest'

import { getBranchProtection } from '../protected-branch'

describe('getBranchProtection', () => {
  it('flags the base branch as protected+submitBlocked+readOnly in prod', () => {
    const result = getBranchProtection({ mode: 'prod', defaultBaseBranch: 'main' }, 'main')
    expect(result).toEqual({
      isProtected: true,
      submitBlocked: true,
      readOnly: true,
      writeBlocked: true,
    })
  })

  it('flags the base branch as protected+submitBlocked but editable in dev', () => {
    const result = getBranchProtection({ mode: 'dev', defaultBaseBranch: 'main' }, 'main')
    expect(result).toEqual({
      isProtected: true,
      submitBlocked: true,
      readOnly: false,
      writeBlocked: false,
    })
  })

  it('does not protect a non-base branch', () => {
    const result = getBranchProtection({ mode: 'prod', defaultBaseBranch: 'main' }, 'feature-x')
    expect(result).toEqual({
      isProtected: false,
      submitBlocked: false,
      readOnly: false,
      writeBlocked: false,
    })
  })

  it('falls back to "main" when defaultBaseBranch is unset', () => {
    const result = getBranchProtection({ mode: 'prod', defaultBaseBranch: undefined }, 'main')
    expect(result).toEqual({
      isProtected: true,
      submitBlocked: true,
      readOnly: true,
      writeBlocked: true,
    })
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
      // No status passed, so writeBlocked always mirrors readOnly here; the
      // status-aware cases live in the 'status clause' describe below.
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
        expect(result).toEqual({ isProtected, submitBlocked, readOnly, writeBlocked: readOnly })
      },
    )
  })

  describe('status clause (writeBlocked)', () => {
    const prod = { mode: 'prod', defaultBaseBranch: 'main' } as const

    it('leaves an editing branch writable', () => {
      const result = getBranchProtection(prod, 'feature-x', undefined, 'editing')
      expect(result.writeBlocked).toBe(false)
      // The status clause must never manufacture base-branch protection.
      expect(result.isProtected).toBe(false)
      expect(result.readOnly).toBe(false)
    })

    it.each(['submitted', 'approved', 'archived'] as const)(
      'blocks writes on a "%s" branch',
      (status) => {
        const result = getBranchProtection(prod, 'feature-x', undefined, status)
        expect(result.writeBlocked).toBe(true)
        // submitBlocked is about the base branch, not the status lock: a
        // submitted branch is still re-submittable after a withdraw.
        expect(result.submitBlocked).toBe(false)
        expect(result.readOnly).toBe(false)
      },
    )

    it('omitting status mirrors readOnly (callers that only need base-branch flags)', () => {
      expect(getBranchProtection(prod, 'feature-x').writeBlocked).toBe(false)
      expect(getBranchProtection(prod, 'main').writeBlocked).toBe(true)
    })

    it('blocks writes on a submitted base branch in dev, where readOnly is false', () => {
      // Dev keeps the base branch editable, so readOnly cannot carry this --
      // without the status clause a submitted base branch stays writable in dev.
      const result = getBranchProtection(
        { mode: 'dev', defaultBaseBranch: 'main' },
        'main',
        undefined,
        'submitted',
      )
      expect(result.readOnly).toBe(false)
      expect(result.writeBlocked).toBe(true)
    })

    it('keeps the base branch write-blocked in prod regardless of status', () => {
      const result = getBranchProtection(prod, 'main', undefined, 'editing')
      expect(result.readOnly).toBe(true)
      expect(result.writeBlocked).toBe(true)
    })
  })
})
