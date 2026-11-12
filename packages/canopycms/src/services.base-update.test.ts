import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTestServices } from './config-test'
import type { BranchContext } from './types'

const worker = vi.hoisted(() => ({
  syncBranchNow: vi.fn(async (): Promise<'answered' | 'busy'> => 'answered'),
  createLocalWorker: vi.fn(),
}))
vi.mock('./worker/cms-worker', () => ({
  createLocalWorker: worker.createLocalWorker.mockImplementation(() => ({
    syncBranchNow: worker.syncBranchNow,
  })),
}))

const schema = { collections: [] }
const workspace = path.join(path.sep, 'workspace')

const context = (baseBranch?: string): BranchContext => ({
  baseRoot: path.join(workspace, 'content-branches'),
  branchRoot: path.join(workspace, 'content-branches', 'content-spring'),
  branch: {
    name: 'content/spring',
    status: 'editing',
    access: {},
    createdBy: 'u1',
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...(baseBranch && { baseBranch }),
  },
})

describe('services runBaseUpdateNow', () => {
  afterEach(() => {
    worker.createLocalWorker.mockClear()
    worker.syncBranchNow.mockClear()
  })

  it('refuses in prod, called directly, without loading or running the worker', async () => {
    const services = await createTestServices({
      schema,
      mode: 'prod',
      defaultBaseBranch: 'main',
    })

    await expect(services.runBaseUpdateNow(context())).rejects.toThrow(
      'in prod mode the worker answers requests for the latest changes',
    )
    expect(worker.createLocalWorker).not.toHaveBeenCalled()
    expect(worker.syncBranchNow).not.toHaveBeenCalled()
  })

  it("runs the merge in dev, over the branch's workspace and against its base", async () => {
    const services = await createTestServices({ schema, mode: 'dev', defaultBaseBranch: 'main' })

    await expect(services.runBaseUpdateNow(context('release'))).resolves.toBe('answered')

    expect(worker.createLocalWorker).toHaveBeenCalledWith({
      workspacePath: workspace,
      baseBranch: 'release',
      contentRoot: 'content',
      settingsBranch: 'canopycms-settings-local',
    })
    expect(worker.syncBranchNow).toHaveBeenCalledWith('content/spring')
  })

  it('falls back to the configured base for a branch that records none', async () => {
    const services = await createTestServices({ schema, mode: 'dev', defaultBaseBranch: 'main' })

    await services.runBaseUpdateNow(context())

    expect(worker.createLocalWorker).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: 'main' }),
    )
  })
})
