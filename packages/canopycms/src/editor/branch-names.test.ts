import { describe, expect, it } from 'vitest'

import { branchUrlName, displayBranchName, resolveListedBranch } from './branch-names'

const listed = (name: string, shortName: string, isProtected = false) => ({
  name,
  shortName,
  isProtected,
})

describe('displayBranchName', () => {
  it('shows the short name, else the full name', () => {
    expect(displayBranchName({ name: 'canopycms/prod/spring', shortName: 'spring' })).toBe('spring')
    expect(displayBranchName({ name: 'feature-x' })).toBe('feature-x')
  })
})

describe('resolveListedBranch', () => {
  const outsideX = listed('x', 'x')
  const namespaceX = listed('canopycms/prod/x', 'x')

  it('opens the namespace branch a short name names before an outside branch of that name', () => {
    expect(resolveListedBranch([outsideX, namespaceX], 'x')).toBe(namespaceX)
    expect(resolveListedBranch([namespaceX, outsideX], 'x')).toBe(namespaceX)
    expect(resolveListedBranch([outsideX, namespaceX], 'canopycms/prod/x')).toBe(namespaceX)
  })

  it('opens the base or active branch by its full name before any short name', () => {
    const base = listed('main', 'main', true)
    const active = listed('staging', 'staging')
    const namespaceMain = listed('canopycms/prod/main', 'main')
    const namespaceStaging = listed('canopycms/prod/staging', 'staging')
    const branches = [namespaceMain, namespaceStaging, base, active]
    expect(resolveListedBranch(branches, 'main', 'staging')).toBe(base)
    expect(resolveListedBranch(branches, 'staging', 'staging')).toBe(active)
  })

  it('falls back to the sanitized form of a raw name', () => {
    const sanitized = listed('feature-x', 'feature-x')
    expect(resolveListedBranch([sanitized], 'feature/x')).toBe(sanitized)
  })

  it('opens no branch for a raw name whose sanitized form a namespace branch shadows', () => {
    const outsideY = listed('feature-y', 'feature-y')
    const namespaceY = listed('canopycms/prod/feature-y', 'feature-y')
    const branches = [outsideY, namespaceY]
    expect(resolveListedBranch(branches, 'feature/y')).toBeUndefined()
    // The pair settles: what the raw name would have canonicalized to opens the shadowing branch.
    expect(resolveListedBranch(branches, 'feature-y')).toBe(namespaceY)
  })
})

describe('branchUrlName', () => {
  it('carries the short name of a namespace branch', () => {
    const spring = listed('canopycms/prod/spring', 'spring')
    expect(branchUrlName([spring], spring)).toBe('spring')
  })

  it('carries the full name of a branch outside the namespace', () => {
    const outside = listed('feature/x', 'feature/x')
    expect(branchUrlName([outside], outside)).toBe('feature/x')
  })

  it('carries the full name when the short name opens another branch', () => {
    const base = listed('main', 'main', true)
    const shadowed = listed('canopycms/prod/main', 'main')
    expect(branchUrlName([base, shadowed], shadowed)).toBe('canopycms/prod/main')
    expect(branchUrlName([base, shadowed], base)).toBe('main')
  })
})
