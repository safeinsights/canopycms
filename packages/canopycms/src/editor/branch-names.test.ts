import { describe, expect, it } from 'vitest'

import {
  branchAddress,
  branchUrlName,
  displayBranchName,
  resolveListedBranch,
} from './branch-names'

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

  it("opens a namespace branch listed under the active branch's name, as the server does", () => {
    // Listed so only while the base cannot be resolved, when the server skips its first step too.
    const active = listed('staging', 'staging')
    const namespaceStaging = listed('canopycms/prod/staging', 'staging')
    expect(resolveListedBranch([active, namespaceStaging], 'staging')).toBe(namespaceStaging)
  })

  it('opens the base by its full name, which the server lists no namespace branch under', () => {
    const base = listed('main', 'main', true)
    // The short name `shortNameOf` gives a namespace branch named after the base.
    const namespaceMain = listed('canopycms/prod/main', 'canopycms/prod/main')
    expect(resolveListedBranch([namespaceMain, base], 'main')).toBe(base)
  })

  it('opens a namespace branch before a protected outside branch that is neither base nor active', () => {
    // An old base: protected, but not the branch the server resolves first.
    const oldBase = listed('x', 'x', true)
    expect(resolveListedBranch([oldBase, namespaceX], 'x')).toBe(namespaceX)
    expect(branchUrlName([oldBase, namespaceX], namespaceX)).toBe('x')
  })

  it('opens by the exact form only the branch with that full name', () => {
    expect(resolveListedBranch([outsideX, namespaceX], 'refs/heads/x')).toBe(outsideX)
    expect(resolveListedBranch([outsideX, namespaceX], 'refs/heads/canopycms/prod/x')).toBe(
      namespaceX,
    )
    // Never a short name.
    expect(resolveListedBranch([namespaceX], 'refs/heads/x')).toBeUndefined()
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

  it('carries the exact form of an outside branch a namespace branch shadows, and each opens its own', () => {
    const outsideX = listed('x', 'x')
    const namespaceX = listed('canopycms/prod/x', 'x')
    const branches = [outsideX, namespaceX]
    expect(branchUrlName(branches, outsideX)).toBe('refs/heads/x')
    expect(branchUrlName(branches, namespaceX)).toBe('x')
    for (const b of branches) {
      expect(resolveListedBranch(branches, branchUrlName(branches, b))).toBe(b)
    }
  })

  it('carries the full name of a namespace branch the server lists under it', () => {
    // `shortNameOf` lists a namespace branch named after the active branch by its full name.
    const active = listed('main', 'main', true)
    const named = listed('canopycms/prod/main', 'canopycms/prod/main')
    expect(branchUrlName([active, named], named)).toBe('canopycms/prod/main')
    expect(branchUrlName([active, named], active)).toBe('main')
  })
})

describe('branchAddress', () => {
  it('is the full name, else the URL form when the full name opens another branch', () => {
    const outsideX = listed('x', 'x')
    const namespaceX = listed('canopycms/prod/x', 'x')
    const unshadowed = listed('feature/y', 'feature/y')
    const branches = [outsideX, namespaceX, unshadowed]
    expect(branchAddress(branches, namespaceX)).toBe('canopycms/prod/x')
    expect(branchAddress(branches, unshadowed)).toBe('feature/y')
    expect(branchAddress(branches, outsideX)).toBe('refs/heads/x')
    for (const b of branches) {
      expect(resolveListedBranch(branches, branchAddress(branches, b))).toBe(b)
    }
  })
})
