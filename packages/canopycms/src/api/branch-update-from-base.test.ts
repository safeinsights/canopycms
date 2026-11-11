import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { updateFromBase } from './branch-update-from-base'
import { BranchMetadataFileManager } from '../branch-metadata'
import { BASE_UPDATE_REQUEST_INTERVAL_MS, SYNC_BRANCH_ACTION } from '../base-update'
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
    } = {},
  ) => {
    const commitSavedWork = vi.fn(options.commitSavedWork ?? (async () => true))
    const ctx = createMockApiContext({ branchContext })
    ctx.services = createMockServices({
      config: { mode: options.mode ?? 'prod', defaultBaseBranch: 'main' },
      commitSavedWork,
    })
    const res = await updateFromBase.handler(ctx, options.req ?? owner, {
      branch: BRANCH as BranchName,
    })
    return { res, commitSavedWork }
  }

  const syncTasks = async () =>
    (await listTasks(taskDir, 'pending')).filter((t) => t.action === SYNC_BRANCH_ACTION)

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

  it('joins a request made within the interval, queueing nothing more', async () => {
    const first = await request(await branchWith())
    const second = await request(await branchWith({ baseUpdateRequestedAt: await recorded() }))

    expect(second.res.status).toBe(202)
    expect(second.res.data?.requestedAt).toBe(first.res.data?.requestedAt)
    expect(await syncTasks()).toHaveLength(1)
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

  it('refuses a branch in review, saying to withdraw it', async () => {
    const { res, commitSavedWork } = await request(await branchWith({ status: 'submitted' }))

    expect(res.status).toBe(409)
    expect(res.error).toContain('Withdraw it from review')
    expect(commitSavedWork).not.toHaveBeenCalled()
    expect(await recorded()).toBeUndefined()
  })

  it('refuses in dev mode, where no worker answers', async () => {
    const { res, commitSavedWork } = await request(await branchWith(), { mode: 'dev' })

    expect(res.status).toBe(409)
    expect(commitSavedWork).not.toHaveBeenCalled()
    expect(await syncTasks()).toHaveLength(0)
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
