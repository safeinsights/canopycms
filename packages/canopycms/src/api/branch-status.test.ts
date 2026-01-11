import { describe, expect, it, vi } from 'vitest'

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

vi.mock('../branch-metadata', () => ({
  BranchMetadataFileManager: vi.fn().mockImplementation(() => ({
    save: mockMetadataUpdate,
  })),
  getBranchMetadataFileManager: vi.fn().mockImplementation(() => ({
    save: mockMetadataUpdate,
  })),
}))

import { WORKFLOW_ROUTES } from './branch-status'
import { createMockApiContext, createMockBranchContext, createMockGitManager } from '../test-utils'

// Extract handlers for testing
const getBranchStatus = WORKFLOW_ROUTES.getStatus.handler
const submitBranchForMerge = WORKFLOW_ROUTES.submit.handler

const baseContext = createMockBranchContext({ branchName: 'feature/x', createdBy: 'u1' })

const makeCtx = (allowed = true) => {
  const mockGit = createMockGitManager()
  mockGit.status.mockResolvedValue({
    files: [{ path: 'content/home.json' } as any],
    ahead: 0,
    behind: 0,
    current: 'feature/x',
  })

  return createMockApiContext({
    branchContext: baseContext,
    allowBranchAccess: allowed,
    services: {
      createGitManagerFor: vi.fn().mockReturnValue(mockGit),
      config: { defaultBranchAccess: 'allow' } as any,
    },
  })
}

describe('branch status api', () => {
  it('gets status', async () => {
    const res = await getBranchStatus(makeCtx(), { user: { type: 'authenticated', userId: 'u1', groups: [] } }, { branch: 'feature/x' })
    expect(res.ok).toBe(true)
    expect(res.data?.branch.name).toBe('feature/x')
  })

  it('denies submit when access forbidden', async () => {
    // User 'u2' is not the creator (u1) and has no ACL access
    const res = await submitBranchForMerge(makeCtx(false), { user: { type: 'authenticated', userId: 'u2', groups: [] } }, { branch: 'feature/x' })
    expect(res.status).toBe(403)
  })

  it('submits branch when allowed', async () => {
    const res = await submitBranchForMerge(makeCtx(true), { user: { type: 'authenticated', userId: 'u1', groups: [] } }, { branch: 'feature/x' })
    expect(res.ok).toBe(true)
  })
})
