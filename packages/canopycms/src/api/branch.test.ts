import { describe, expect, it, vi } from 'vitest'

import { createBranch, listBranches } from './branch'
import type { ApiContext } from './types'

vi.mock('../branch-workspace', () => {
  return {
    BranchWorkspaceManager: vi.fn().mockImplementation(() => ({
      openOrCreateBranch: vi.fn().mockResolvedValue({
        state: {
          branch: {
            name: 'feature/test',
            status: 'editing',
            access: {},
            createdBy: 'user-1',
            createdAt: 'now',
            updatedAt: 'now',
          },
        },
      }),
    })),
  }
})

vi.mock('../branch-registry', () => {
  return {
    BranchRegistry: vi.fn().mockImplementation(() => ({
      list: vi.fn().mockResolvedValue([
        {
          branch: { name: 'feature/a', status: 'editing', access: {}, createdBy: 'u1', createdAt: 'now', updatedAt: 'now' },
        },
      ]),
    })),
  }
})

const baseCtx: ApiContext = {
  services: {
    config: { schema: [] } as any,
    checkBranchAccess: vi.fn(),
    checkContentAccess: vi.fn(),
  },
  getBranchState: vi.fn(),
}

describe('branch api', () => {
  it('rejects missing branch name', async () => {
    const res = await createBranch(baseCtx, { user: { userId: 'u1' } })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(400)
  })

  it('creates branch via workspace manager', async () => {
    const res = await createBranch(baseCtx, { user: { userId: 'u1' }, body: { branch: 'feature/test' } })
    expect(res.ok).toBe(true)
    expect(res.data?.branch.branch.name).toBe('feature/test')
  })

  it('lists branches', async () => {
    const res = await listBranches(baseCtx)
    expect(res.ok).toBe(true)
    expect(res.data?.branches[0].branch.name).toBe('feature/a')
  })
})
