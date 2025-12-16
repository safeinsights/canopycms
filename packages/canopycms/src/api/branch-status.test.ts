import { describe, expect, it, vi } from 'vitest'

import { getBranchStatus, submitBranchForMerge } from './branch-status'
import type { ApiContext } from './types'

vi.mock('../branch-metadata', () => {
  return {
    BranchMetadata: vi.fn().mockImplementation(() => ({
      update: vi.fn().mockResolvedValue(undefined),
    })),
  }
})

const baseState = {
  branch: {
    name: 'feature/x',
    status: 'editing',
    access: {},
    createdBy: 'u1',
    createdAt: 'now',
    updatedAt: 'now',
  },
}

const makeCtx = (allowed = true): ApiContext => ({
  services: {
    config: { schema: [] } as any,
    checkBranchAccess: vi
      .fn()
      .mockReturnValue({ allowed, reason: allowed ? 'allowed_by_acl' : 'denied_by_acl' }),
    checkContentAccess: vi.fn(),
    createGitManagerFor: vi.fn().mockReturnValue({
      checkoutBranch: vi.fn(),
      status: vi
        .fn()
        .mockResolvedValue({
          files: [{ path: 'content/home.json' } as any],
          ahead: 0,
          behind: 0,
          current: 'feature/x',
        }),
      add: vi.fn(),
      commit: vi.fn(),
      push: vi.fn(),
    }),
  },
  getBranchState: vi.fn().mockResolvedValue(baseState),
})

describe('branch status api', () => {
  it('gets status', async () => {
    const res = await getBranchStatus(makeCtx(), { branch: 'feature/x' })
    expect(res.ok).toBe(true)
    expect(res.data?.branch.branch.name).toBe('feature/x')
  })

  it('denies submit when access forbidden', async () => {
    const res = await submitBranchForMerge(
      makeCtx(false),
      { user: { userId: 'u1' } },
      { branch: 'feature/x' },
    )
    expect(res.status).toBe(403)
  })

  it('submits branch when allowed', async () => {
    const res = await submitBranchForMerge(
      makeCtx(true),
      { user: { userId: 'u1' } },
      { branch: 'feature/x' },
    )
    expect(res.ok).toBe(true)
  })
})
