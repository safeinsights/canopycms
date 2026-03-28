import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  BranchPathError,
  ensureBranchRoot,
  getDefaultBranchBase,
  resolveBranchPath,
} from '../branch'

describe('paths', () => {
  it('resolves prod content branches root from default workspace', () => {
    // In prod mode, uses default workspace path (or CANOPYCMS_WORKSPACE_ROOT env var)
    // Override parameter is not used in prod mode - workspace comes from env
    const base = getDefaultBranchBase('prod')
    expect(base).toContain('content-branches')
  })

  it('sanitizes branch names and prevents traversal', () => {
    expect(() =>
      resolveBranchPath({
        mode: 'dev',
        branchName: '../evil',
      }),
    ).toThrow(BranchPathError)
  })

  it('ensures branch root is created under base in dev mode', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-branches-'))
    const { branchRoot, baseRoot } = await ensureBranchRoot({
      mode: 'dev',
      branchName: 'feature/test',
      basePathOverride: temp,
    })
    const stat = await fs.stat(branchRoot)
    expect(stat.isDirectory()).toBe(true)
    // baseRoot is now .canopy-dev/content-branches inside the override path
    expect(baseRoot).toBe(path.resolve(temp, '.canopy-dev', 'content-branches'))
    expect(branchRoot.startsWith(baseRoot)).toBe(true)
  })

  it('resolves branch path correctly in dev mode', () => {
    const result = resolveBranchPath({
      mode: 'dev',
      branchName: 'current',
    })
    expect(result.branchRoot).toContain('.canopy-dev/content-branches/current')
    expect(result.baseRoot).toContain('.canopy-dev/content-branches')
  })
})
