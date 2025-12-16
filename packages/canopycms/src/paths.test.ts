import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { BranchPathError, ensureBranchRoot, getDefaultBranchBase, resolveBranchPath } from './paths'

describe('paths', () => {
  it('resolves prod base with env override', () => {
    const base = getDefaultBranchBase('prod', '/tmp/efs')
    expect(base).toBe(path.resolve('/tmp/efs'))
  })

  it('sanitizes branch names and prevents traversal', () => {
    expect(() =>
      resolveBranchPath({
        mode: 'local-prod-sim',
        branchName: '../evil',
      })
    ).toThrow(BranchPathError)
  })

  it('ensures branch root is created under base', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-branches-'))
    const { branchRoot, metadataRoot } = await ensureBranchRoot({
      mode: 'local-prod-sim',
      branchName: 'feature/test',
      basePathOverride: temp,
    })
    const stat = await fs.stat(branchRoot)
    expect(stat.isDirectory()).toBe(true)
    expect(branchRoot.startsWith(temp)).toBe(true)
    expect(metadataRoot).toBe(branchRoot)
  })

  it('uses cwd for local-simple mode', () => {
    const { baseRoot, branchRoot, metadataRoot } = resolveBranchPath({
      mode: 'local-simple',
      branchName: 'current',
    })
    expect(baseRoot).toBe(path.resolve(process.cwd()))
    expect(branchRoot).toBe(path.resolve(process.cwd()))
    expect(metadataRoot).toBe(branchRoot)
  })
})
