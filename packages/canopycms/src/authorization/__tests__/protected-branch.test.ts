import { describe, expect, it } from 'vitest'

import { getBranchProtection } from '../protected-branch'

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
})
