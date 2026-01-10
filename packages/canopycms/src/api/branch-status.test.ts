import { describe, expect, it, vi } from 'vitest'

import { WORKFLOW_ROUTES } from './branch-status'
import type { ApiContext } from './types'

// Extract handlers for testing
const getBranchStatus = WORKFLOW_ROUTES.getStatus.handler
const submitBranchForMerge = WORKFLOW_ROUTES.submit.handler

const mockMetadataUpdate = vi.fn().mockResolvedValue({
  schemaVersion: 1,
  branch: {
    name: 'feature/x',
    status: 'submitted',
    access: {},
    createdBy: 'u1',
    createdAt: 'now',
    updatedAt: 'now',
  },
})

vi.mock('../branch-metadata', () => {
  return {
    BranchMetadataFileManager: vi.fn().mockImplementation(() => ({
      save: mockMetadataUpdate,
    })),
    getBranchMetadataFileManager: vi.fn().mockImplementation(() => ({
      save: mockMetadataUpdate,
    })),
  }
})

const baseContext = {
  baseRoot: '/tmp/base',
  branchRoot: '/tmp/base/feature-x',
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
    flatSchema: [],
    checkBranchAccess: vi
      .fn()
      .mockReturnValue({ allowed, reason: allowed ? 'allowed_by_acl' : 'denied_by_acl' }),
    checkPathAccess: undefined as any,
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
    bootstrapAdminIds: new Set<string>(),
    registry: undefined as any,
    commitFiles: vi.fn(),
    submitBranch: vi.fn(),
  },
  getBranchContext: vi.fn().mockResolvedValue(baseContext),
})

describe('branch status api', () => {
  it('gets status', async () => {
    const res = await getBranchStatus(
      makeCtx(),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
    )
    expect(res.ok).toBe(true)
    expect(res.data?.branch.name).toBe('feature/x')
  })

  it('denies submit when access forbidden', async () => {
    const res = await submitBranchForMerge(
      makeCtx(false),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
    )
    expect(res.status).toBe(403)
  })

  it('submits branch when allowed', async () => {
    const res = await submitBranchForMerge(
      makeCtx(true),
      { user: { type: 'authenticated', userId: 'u1', groups: [] } },
      { branch: 'feature/x' },
    )
    expect(res.ok).toBe(true)
  })
})
