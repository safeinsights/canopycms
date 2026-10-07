import { describe, expect, it } from 'vitest'

import { BranchPathError, getDefaultBranchBase, resolveBranchPath } from '../branch'

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

  it('resolves branch path correctly in dev mode', () => {
    const result = resolveBranchPath({
      mode: 'dev',
      branchName: 'current',
    })
    expect(result.branchRoot).toContain('.canopy-dev/content-branches/current')
    expect(result.baseRoot).toContain('.canopy-dev/content-branches')
  })
})
