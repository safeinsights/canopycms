/**
 * `CmsWorkerConfig.githubGateway`: a worker given a gateway another process serves uses it, and
 * refuses the options that configure the in-process one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { WORKER_STATUS_FILE } from '../task-queue/worker-status'
import { mockConsole, type MockConsole } from '../test-utils'
import type { WorkerStatusReport } from '../types'
import { CmsWorker, type CmsWorkerConfig } from './cms-worker'
import { resolveWorkerGitHubAuth } from './github-auth'
import { createLocalGitHubGateway } from './github-gateway'

let tmpDir: string
let workspacePath: string
let consoleSpy: MockConsole

beforeEach(async () => {
  consoleSpy = mockConsole()
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-worker-gateway-config-'))
  workspacePath = path.join(tmpDir, 'workspace')
  await fs.mkdir(workspacePath, { recursive: true })
})

afterEach(async () => {
  consoleSpy.restore()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const readStatus = async (): Promise<WorkerStatusReport> =>
  JSON.parse(
    await fs.readFile(path.join(workspacePath, '.tasks', WORKER_STATUS_FILE), 'utf-8'),
  ) as WorkerStatusReport

/** A real gateway, never reached: the worker only prepares it, and `prepare()` is made to fail. */
function stoppedGateway() {
  const gateway = createLocalGitHubGateway({
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    auth: resolveWorkerGitHubAuth({ githubToken: 'unused' }),
    githubApp: false,
    stateDirectory: path.join(tmpDir, 'state'),
    timeoutMs: 30_000,
    prefetch: false,
  })
  const prepare = vi.spyOn(gateway, 'prepare').mockRejectedValue(new Error('stop after prepare'))
  return { gateway, prepare }
}

const makeWorker = (config: Partial<CmsWorkerConfig>) =>
  new CmsWorker({
    workspacePath,
    githubOwner: 'test-owner',
    githubRepo: 'test-repo',
    baseBranch: 'main',
    ...config,
  })

describe('CmsWorkerConfig.githubGateway', () => {
  it('uses the gateway it is given, preparing it at startup', async () => {
    const { gateway, prepare } = stoppedGateway()
    const worker = makeWorker({ githubGateway: gateway })

    await expect(worker.start()).rejects.toThrow('stop after prepare')

    expect(prepare).toHaveBeenCalledTimes(1)
    expect((await readStatus()).lastFatalError?.message).toContain('stop after prepare')
  })

  it.each([
    ['githubToken', { githubToken: 'ghp_static' }],
    ['refreshGitHubToken', { refreshGitHubToken: async () => undefined }],
    ['protectedBranches', { protectedBranches: ['release/*'] }],
    ['legacyBranches', { legacyBranches: ['spring'] }],
  ])('records %s beside it as the startup failure, naming both', async (name, extra) => {
    const { gateway, prepare } = stoppedGateway()
    const worker = makeWorker({ githubGateway: gateway, ...extra })

    await expect(worker.start()).rejects.toThrow(/githubGateway is exclusive with/)

    const status = await readStatus()
    expect(status.lastFatalError?.phase).toBe('startup')
    expect(status.lastFatalError?.message).toContain('githubGateway')
    expect(status.lastFatalError?.message).toContain(name)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('names every option that conflicts', async () => {
    const { gateway } = stoppedGateway()
    const worker = makeWorker({
      githubGateway: gateway,
      githubToken: 'ghp_static',
      protectedBranches: ['release/*'],
    })

    await expect(worker.start()).rejects.toThrow(/githubToken, protectedBranches/)
  })

  it('takes an empty protectedBranches beside it', async () => {
    const { gateway, prepare } = stoppedGateway()
    const worker = makeWorker({ githubGateway: gateway, protectedBranches: [] })

    await expect(worker.start()).rejects.toThrow('stop after prepare')

    expect(prepare).toHaveBeenCalledTimes(1)
  })
})
