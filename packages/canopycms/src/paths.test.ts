import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { BranchPathError, ensureBranchRoot, getDefaultBranchBase, resolveBranchPath } from './paths'

describe('paths', () => {
  it('resolves prod branches root from default workspace', () => {
    // In prod mode, uses default workspace path (or CANOPYCMS_WORKSPACE_ROOT env var)
    // Override parameter is not used in prod mode - workspace comes from env
    const base = getDefaultBranchBase('prod')
    expect(base).toContain('branches')
  })

  it('sanitizes branch names and prevents traversal', () => {
    expect(() =>
      resolveBranchPath({
        mode: 'prod-sim',
        branchName: '../evil',
      })
    ).toThrow(BranchPathError)
  })

  it('ensures branch root is created under base in prod-sim', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-branches-'))
    const { branchRoot, baseRoot } = await ensureBranchRoot({
      mode: 'prod-sim',
      branchName: 'feature/test',
      basePathOverride: temp,
    })
    const stat = await fs.stat(branchRoot)
    expect(stat.isDirectory()).toBe(true)
    // baseRoot is now .canopy-prod-sim/branches inside the override path
    expect(baseRoot).toBe(path.resolve(temp, '.canopy-prod-sim', 'branches'))
    expect(branchRoot.startsWith(baseRoot)).toBe(true)
  })

  it('throws error when using branching functions in dev mode', () => {
    expect(() =>
      resolveBranchPath({
        mode: 'dev',
        branchName: 'current',
      })
    ).toThrow('No branching in dev mode')
  })
})
