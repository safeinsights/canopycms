import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { simpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
let workspace: string

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
  // A branch clone whose origin is `origin`: the workspace's remote.git unless given.
  const cloneWithOrigin = async (origin?: string) => {
    const branchRoot = path.join(workspace, 'content-branches', 'content-spring')
    await fs.mkdir(branchRoot, { recursive: true })
    const git = simpleGit(branchRoot)
    await git.init()
    await git.addRemote('origin', origin ?? path.join(workspace, 'remote.git'))
  }

  beforeEach(async () => {
    workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-run-now-')))
    await fs.mkdir(path.join(workspace, 'remote.git'))
  })

  afterEach(async () => {
    worker.createLocalWorker.mockClear()
    worker.syncBranchNow.mockClear()
    await fs.rm(workspace, { recursive: true, force: true })
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
    await cloneWithOrigin()
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
    await cloneWithOrigin(pathToFileURL(path.join(workspace, 'remote.git')).href)
    const services = await createTestServices({ schema, mode: 'dev', defaultBaseBranch: 'main' })

    await services.runBaseUpdateNow(context())

    expect(worker.createLocalWorker).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: 'main' }),
    )
  })

  it('runs nothing for a clone of another remote, which the local worker never fetches', async () => {
    await cloneWithOrigin('https://example.com/site.git')
    const services = await createTestServices({ schema, mode: 'dev', defaultBaseBranch: 'main' })

    await expect(services.runBaseUpdateNow(context())).resolves.toBe('other-remote')
    expect(worker.createLocalWorker).not.toHaveBeenCalled()
  })
})
