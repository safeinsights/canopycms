import { describe, it, expect } from 'vitest'
import { sanitizeBranchName, resolveBranchPath, BranchPathError } from './branch'
import { isSettingsBranchName } from './branch-name'

describe('sanitizeBranchName', () => {
  it('passes through simple valid names', () => {
    expect(sanitizeBranchName('my-branch')).toBe('my-branch')
    expect(sanitizeBranchName('feature_1.0')).toBe('feature_1.0')
  })

  it('replaces invalid characters with hyphens', () => {
    expect(sanitizeBranchName('my branch')).toBe('my-branch')
    expect(sanitizeBranchName('feat/login')).toBe('feat-login')
    expect(sanitizeBranchName('a@b#c$d')).toBe('a-b-c-d')
  })

  it('collapses consecutive hyphens', () => {
    expect(sanitizeBranchName('a--b')).toBe('a-b')
    expect(sanitizeBranchName('a///b')).toBe('a-b')
  })

  it('trims leading dots', () => {
    expect(sanitizeBranchName('.hidden')).toBe('hidden')
    expect(sanitizeBranchName('...multi')).toBe('multi')
  })

  it('trims trailing dots', () => {
    expect(sanitizeBranchName('name.')).toBe('name')
    expect(sanitizeBranchName('name...')).toBe('name')
  })

  it('trims dots on both sides', () => {
    expect(sanitizeBranchName('..both..')).toBe('both')
  })

  it('preserves interior dots', () => {
    expect(sanitizeBranchName('v1.2.3')).toBe('v1.2.3')
  })

  it('falls back to "branch" for empty result', () => {
    expect(sanitizeBranchName('')).toBe('branch')
    expect(sanitizeBranchName('...')).toBe('branch')
    expect(sanitizeBranchName('///')).toBe('-')
  })

  it('handles long strings with many dots without excessive backtracking', () => {
    const manyDots = '.'.repeat(10_000) + 'a'
    expect(sanitizeBranchName(manyDots)).toBe('a')
  })
})

describe('isSettingsBranchName', () => {
  it('matches the reserved prefix, including names that only sanitize into it', () => {
    expect(isSettingsBranchName('canopycms-settings-prod')).toBe(true)
    expect(isSettingsBranchName('canopycms/settings-prod')).toBe(true)
    expect(isSettingsBranchName('canopycms-settings')).toBe(false)
    expect(isSettingsBranchName('feature/settings')).toBe(false)
  })

  it('matches a configured settings branch outside the prefix, compared sanitized', () => {
    expect(isSettingsBranchName('site-settings', 'site-settings')).toBe(true)
    expect(isSettingsBranchName('site/settings', 'site-settings')).toBe(true)
    expect(isSettingsBranchName('site-settings')).toBe(false)
    expect(isSettingsBranchName('main', 'site-settings')).toBe(false)
  })
})

describe('resolveBranchPath', () => {
  it('refuses a settings-branch name, which never holds a content workspace', () => {
    for (const branchName of ['canopycms-settings-prod', 'canopycms/settings-prod']) {
      expect(() =>
        resolveBranchPath({ branchName, mode: 'dev', basePathOverride: '/tmp/x' }),
      ).toThrow(BranchPathError)
    }
  })

  it('resolves an ordinary branch name', () => {
    const result = resolveBranchPath({
      branchName: 'feature/settings',
      mode: 'dev',
      basePathOverride: '/tmp/x',
    })
    expect(result.branchName).toBe('feature-settings')
  })
})
