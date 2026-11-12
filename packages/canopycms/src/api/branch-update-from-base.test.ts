import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { updateFromBase } from './branch-update-from-base'
import { BranchMetadataFileManager } from '../branch-metadata'
import {
  BASE_UPDATE_GIVE_UP_MS,
  BASE_UPDATE_REQUEST_INTERVAL_MS,
  SYNC_BRANCH_ACTION,
} from '../base-update'
import { enqueueTask, listTasks } from '../task-queue/cms-task-queue'
import { ContentWriteLockBusyError } from '../utils/content-write-lock'
import type { BranchName } from '../paths/types'
import type { BranchContext, BranchStatus } from '../types'
import type { ApiRequest } from './types'
import type { CanopyServices } from '../services'
import {
  createMockApiContext,
  createMockServices,
  mockConsole,
  type MockConsole,
} from '../test-utils'

const BRANCH = 'content/spring'
const owner: ApiRequest = { user: { type: 'authenticated', userId: 'u1', groups: [] } }
const stranger: ApiRequest = { user: { type: 'authenticated', userId: 'u2', groups: [] } }

describe('POST /:branch/update-from-base', () => {
  let tmpDir: string
  let branchRoot: string
  let baseRoot: string
  let taskDir: string
  let consoleSpy: MockConsole
  const savedWorkspace = process.env.CANOPYCMS_WORKSPACE_ROOT

  beforeEach(async () => {
    consoleSpy = mockConsole()
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-update-from-base-'))
    process.env.CANOPYCMS_WORKSPACE_ROOT = tmpDir
    taskDir = path.join(tmpDir, '.tasks')
    baseRoot = path.join(tmpDir, 'content-branches')
    branchRoot = path.join(baseRoot, 'content-spring')
    await fs.mkdir(branchRoot, { recursive: true })
  })

  afterEach(async () => {
    vi.useRealTimers()
    consoleSpy.restore()
    if (savedWorkspace === undefined) delete process.env.CANOPYCMS_WORKSPACE_ROOT
    else process.env.CANOPYCMS_WORKSPACE_ROOT = savedWorkspace
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  /** The branch as branch.json holds it and the guard would load it. */
  const branchWith = async (
    data: { status?: BranchStatus; baseUpdateRequestedAt?: string } = {},
  ): Promise<BranchContext> => {
    const saved = await BranchMetadataFileManager.get(branchRoot, baseRoot).save({
      branch: {
        name: BRANCH,
        status: data.status ?? 'editing',
        access: {},
        createdBy: 'u1',
        ...(data.baseUpdateRequestedAt && { baseUpdateRequestedAt: data.baseUpdateRequestedAt }),
      },
    })
    return { branchRoot, baseRoot, branch: saved.branch }
  }

  const request = async (
    branchContext: BranchContext,
    options: {
      req?: ApiRequest
      mode?: 'prod' | 'dev'
      commitSavedWork?: CanopyServices['commitSavedWork']
      runBaseUpdateNow?: CanopyServices['runBaseUpdateNow']
    } = {},
  ) => {
    const commitSavedWork = vi.fn(options.commitSavedWork ?? (async () => true))
    const runBaseUpdateNow = vi.fn(options.runBaseUpdateNow ?? answerNow('merged'))
    const ctx = createMockApiContext({ branchContext })
    ctx.services = createMockServices({
      config: { mode: options.mode ?? 'prod', defaultBaseBranch: 'main' },
      commitSavedWork,
      runBaseUpdateNow,
    })
    const res = await updateFromBase.handler(ctx, options.req ?? owner, {
      branch: BRANCH as BranchName,
    })
    return { res, commitSavedWork, runBaseUpdateNow }
  }

  /** A run in the request that answers the branch's request with `outcome`, as the worker's does. */
  const answerNow =
    (outcome: 'merged' | 'conflicts' | 'up-to-date') =>
    async (context: BranchContext): Promise<'answered'> => {
      const meta = await BranchMetadataFileManager.loadOnly(context.branchRoot)
      await BranchMetadataFileManager.get(branchRoot, baseRoot).save({
        branch: { lastBaseUpdate: { at: meta!.branch.baseUpdateRequestedAt!, outcome } },
      })
      return 'answered'
    }

  const syncTasks = async () =>
    (await listTasks(taskDir, 'pending')).filter((t) => t.action === SYNC_BRANCH_ACTION)

  const loadBranch = async () => (await BranchMetadataFileManager.loadOnly(branchRoot))?.branch

  const recorded = async () =>
    (await BranchMetadataFileManager.loadOnly(branchRoot))?.branch.baseUpdateRequestedAt

  it('commits the saved work, records the request and queues the wake-up', async () => {
    const { res, commitSavedWork } = await request(await branchWith())

    expect(res.status).toBe(202)
    expect(commitSavedWork).toHaveBeenCalledTimes(1)
    const requestedAt = res.data?.requestedAt
    expect(requestedAt).toBeDefined()
    expect(await recorded()).toBe(requestedAt)
    expect(res.data?.branch.baseUpdateRequestedAt).toBe(requestedAt)
    const tasks = await syncTasks()
    expect(tasks.map((t) => t.payload)).toEqual([{ branch: BRANCH }])
  })

  it('never runs the merge in a prod request: the worker answers it', async () => {
    const { res, runBaseUpdateNow } = await request(await branchWith())

    expect(res.status).toBe(202)
    expect(runBaseUpdateNow).not.toHaveBeenCalled()
    expect(res.data?.branch.lastBaseUpdate).toBeUndefined()
    expect(await syncTasks()).toHaveLength(1)
  })

  it('joins a request made within the interval, queueing nothing more', async () => {
    const first = await request(await branchWith())
    // The worker has taken the first wake-up, so only the interval holds the second.
    await fs.rm(path.join(taskDir, 'pending'), { recursive: true })
    const second = await request(await branchWith({ baseUpdateRequestedAt: await recorded() }))

    expect(second.res.status).toBe(202)
    expect(second.res.data?.requestedAt).toBe(first.res.data?.requestedAt)
    expect(await syncTasks()).toHaveLength(0)
  })

  it('joins a request whose wake-up is still queued, however old', async () => {
    const old = new Date(Date.now() - 10 * BASE_UPDATE_REQUEST_INTERVAL_MS).toISOString()
    await enqueueTask(taskDir, { action: SYNC_BRANCH_ACTION, payload: { branch: BRANCH } })

    const { res } = await request(await branchWith({ baseUpdateRequestedAt: old }))

    expect(res.data?.requestedAt).toBe(old)
    expect(await syncTasks()).toHaveLength(1)
  })

  it('takes a new request once the interval has passed and nothing is queued', async () => {
    const old = new Date(Date.now() - BASE_UPDATE_REQUEST_INTERVAL_MS - 1).toISOString()

    const { res } = await request(await branchWith({ baseUpdateRequestedAt: old }))

    expect(res.data?.requestedAt).not.toBe(old)
    expect(await recorded()).toBe(res.data?.requestedAt)
    expect(await syncTasks()).toHaveLength(1)
  })

  it('takes a new request after an answered one, as a Retry after a failure is', async () => {
    const first = await request(await branchWith())
    const requestedAt = first.res.data!.requestedAt
    await BranchMetadataFileManager.get(branchRoot, baseRoot).save({
      branch: { lastBaseUpdate: { at: requestedAt, outcome: 'failed' } },
    })
    await fs.rm(path.join(taskDir, 'pending'), { recursive: true })
    await new Promise((resolve) => setTimeout(resolve, 5))

    const { res } = await request({ branchRoot, baseRoot, branch: (await loadBranch())! })

    expect(res.data?.requestedAt).not.toBe(requestedAt)
    expect(await syncTasks()).toHaveLength(1)
  })

  it('lets a recent answer stand for another click, queueing nothing', async () => {
    const requestedAt = new Date(Date.now() - 5_000).toISOString()
    await branchWith({ baseUpdateRequestedAt: requestedAt })
    await BranchMetadataFileManager.get(branchRoot, baseRoot).save({
      branch: { lastBaseUpdate: { at: new Date().toISOString(), outcome: 'up-to-date' } },
    })

    const { res } = await request({ branchRoot, baseRoot, branch: (await loadBranch())! })

    expect(res.data?.requestedAt).toBe(requestedAt)
    expect(res.data?.branch.lastBaseUpdate?.outcome).toBe('up-to-date')
    expect(await syncTasks()).toHaveLength(0)
  })

  it('renews a request the editor has stopped waiting on, its queued wake-up serving both', async () => {
    const old = new Date(Date.now() - BASE_UPDATE_GIVE_UP_MS - 1).toISOString()
    await enqueueTask(taskDir, { action: SYNC_BRANCH_ACTION, payload: { branch: BRANCH } })

    const { res } = await request(await branchWith({ baseUpdateRequestedAt: old }))

    expect(res.data?.requestedAt).not.toBe(old)
    expect(await recorded()).toBe(res.data?.requestedAt)
    expect(await syncTasks()).toHaveLength(1)
  })

  it('records nothing for a branch submitted since the guard read it', async () => {
    const context = await branchWith()
    await BranchMetadataFileManager.get(branchRoot, baseRoot).save({
      branch: { status: 'submitted' },
    })

    const { res } = await request(context)

    expect(res.status).toBe(409)
    expect(await recorded()).toBeUndefined()
    expect(await syncTasks()).toHaveLength(0)
  })

  it('refuses a branch in review, saying to withdraw it', async () => {
    const { res, commitSavedWork } = await request(await branchWith({ status: 'submitted' }))

    expect(res.status).toBe(409)
    expect(res.error).toContain('Withdraw it from review')
    expect(commitSavedWork).not.toHaveBeenCalled()
    expect(await recorded()).toBeUndefined()
  })

  describe('in dev mode, which runs the merge in the request', () => {
    it('commits the saved work, then answers the request before responding', async () => {
      const { res, commitSavedWork, runBaseUpdateNow } = await request(await branchWith(), {
        mode: 'dev',
        runBaseUpdateNow: answerNow('conflicts'),
      })

      expect(res.status).toBe(202)
      expect(commitSavedWork).toHaveBeenCalledTimes(1)
      expect(runBaseUpdateNow).toHaveBeenCalledTimes(1)
      expect(commitSavedWork.mock.invocationCallOrder[0]).toBeLessThan(
        runBaseUpdateNow.mock.invocationCallOrder[0],
      )
      const requestedAt = res.data?.requestedAt
      expect(res.data?.branch.baseUpdateRequestedAt).toBe(requestedAt)
      expect(res.data?.branch.lastBaseUpdate).toEqual({ at: requestedAt, outcome: 'conflicts' })
      expect(await syncTasks()).toHaveLength(0)
    })

    it('runs nothing for a request it joins: the run that made it answers', async () => {
      const pending = new Date(Date.now() - 1_000).toISOString()
      const { res, runBaseUpdateNow } = await request(
        await branchWith({ baseUpdateRequestedAt: pending }),
        { mode: 'dev' },
      )

      expect(res.status).toBe(202)
      expect(res.data?.requestedAt).toBe(pending)
      expect(runBaseUpdateNow).not.toHaveBeenCalled()
      expect(await syncTasks()).toHaveLength(0)
    })

    it('says to try again in a moment when a lock held the merge back', async () => {
      const { res } = await request(await branchWith(), {
        mode: 'dev',
        runBaseUpdateNow: async () => 'busy',
      })

      expect(res.status).toBe(409)
      expect(res.error).toBe(
        'This branch is busy with a save or another update. Nothing changed; try again in a moment.',
      )
    })

    it('answers the request failed when the run throws, so the form is not held', async () => {
      const { res } = await request(await branchWith(), {
        mode: 'dev',
        runBaseUpdateNow: async () => {
          throw new Error('git broke')
        },
      })

      expect(res.status).toBe(500)
      const branch = await loadBranch()
      expect(branch?.lastBaseUpdate).toEqual({
        at: branch?.baseUpdateRequestedAt,
        outcome: 'failed',
      })
      expect(consoleSpy).toHaveErrored('Could not bring the latest changes into')
    })
  })

  it('refuses someone who may not take workflow actions on the branch', async () => {
    const { res, commitSavedWork } = await request(await branchWith(), { req: stranger })

    expect(res.status).toBe(403)
    expect(commitSavedWork).not.toHaveBeenCalled()
  })

  it('records nothing when a sync or a save holds the branch', async () => {
    const { res } = await request(await branchWith(), {
      commitSavedWork: async () => {
        throw new ContentWriteLockBusyError()
      },
    })

    expect(res.status).toBe(409)
    expect(await recorded()).toBeUndefined()
    expect(await syncTasks()).toHaveLength(0)
  })
})
