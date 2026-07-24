import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ADMIN_ROUTES } from './admin'
import type { ApiContext, ApiRequest } from './types'
import { createMockApiContext, createMockUser } from '../test-utils'
import { enqueueTask, dequeueTask, failTask } from '../worker/task-queue'

// Extract composed (guard + handler) functions for testing, matching
// branch-merge.test.ts's pattern.
const statusHandler = ADMIN_ROUTES.status.handler
const listTasksHandler = ADMIN_ROUTES.listTasks.handler
const retryTaskHandler = ADMIN_ROUTES.retryTask.handler
const deleteTaskHandler = ADMIN_ROUTES.deleteTask.handler

describe('admin api', () => {
  let tmpDir: string
  let taskDir: string
  const originalWorkspaceRoot = process.env.CANOPYCMS_WORKSPACE_ROOT
  let ctx: ApiContext
  let req: ApiRequest

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-admin-test-'))
    // getTaskQueueDir({mode:'prod'}) resolves to {CANOPYCMS_WORKSPACE_ROOT}/.tasks
    process.env.CANOPYCMS_WORKSPACE_ROOT = tmpDir
    taskDir = path.join(tmpDir, '.tasks')

    ctx = createMockApiContext({ services: { config: { mode: 'prod' } as any } })
    req = { user: createMockUser('admin'), body: {} }
  })

  afterEach(async () => {
    process.env.CANOPYCMS_WORKSPACE_ROOT = originalWorkspaceRoot
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('GET /admin/status', () => {
    it('returns zeroed stats, absent worker, and null status for an empty queue', async () => {
      const result = await statusHandler(ctx, req)

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data?.queue).toEqual({
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        corrupt: 0,
      })
      expect(result.data?.queue.oldestPendingAgeMs).toBeUndefined()
      expect(result.data?.worker).toEqual({ state: 'absent' })
      expect(result.data?.workerStatus).toBeNull()
      expect(result.data?.mode).toBe('prod')
    })

    it('reports pending count and a non-negative oldestPendingAgeMs when pending/ has a file', async () => {
      await enqueueTask(taskDir, { action: 'push-branch', payload: {} })

      const result = await statusHandler(ctx, req)

      expect(result.data?.queue.pending).toBe(1)
      expect(result.data?.queue.oldestPendingAgeMs).toBeGreaterThanOrEqual(0)
    })

    it('classifies a fresh .worker-lock as alive', async () => {
      await fs.mkdir(path.join(taskDir, '.worker-lock'), { recursive: true })

      const result = await statusHandler(ctx, req)

      expect(result.data?.worker.state).toBe('alive')
      expect(result.data?.worker.lockMtime).toBeTruthy()
      expect(result.data?.worker.lockAgeMs).toBeGreaterThanOrEqual(0)
    })

    it('classifies a 10-minute-old .worker-lock as stale', async () => {
      const lockPath = path.join(taskDir, '.worker-lock')
      await fs.mkdir(lockPath, { recursive: true })
      const staleTime = new Date(Date.now() - 10 * 60_000)
      await fs.utimes(lockPath, staleTime, staleTime)

      const result = await statusHandler(ctx, req)

      expect(result.data?.worker.state).toBe('stale')
    })

    it('returns the parsed worker status report when worker-status.json is valid', async () => {
      await fs.mkdir(taskDir, { recursive: true })
      const report = {
        version: 1,
        startedAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:05:00.000Z',
      }
      await fs.writeFile(path.join(taskDir, 'worker-status.json'), JSON.stringify(report), 'utf-8')

      const result = await statusHandler(ctx, req)

      expect(result.data?.workerStatus).toEqual(report)
      expect(result.data?.statusReadError).toBeUndefined()
    })

    it('returns null status + statusReadError for a garbage worker-status.json', async () => {
      await fs.mkdir(taskDir, { recursive: true })
      await fs.writeFile(path.join(taskDir, 'worker-status.json'), 'not json {{{', 'utf-8')

      const result = await statusHandler(ctx, req)

      expect(result.data?.workerStatus).toBeNull()
      expect(result.data?.statusReadError).toBeTruthy()
    })
  })

  describe('GET /admin/tasks/:status', () => {
    it('returns tasks for a status directory', async () => {
      const id = await enqueueTask(taskDir, { action: 'push-branch', payload: {} })
      const task = await dequeueTask(taskDir)
      expect(task?.id).toBe(id)
      await failTask(taskDir, id, 'boom')

      const result = await listTasksHandler(ctx, req, { status: 'failed' })

      expect(result.ok).toBe(true)
      expect(result.data?.tasks).toHaveLength(1)
      expect(result.data?.tasks?.[0].id).toBe(id)
      expect(result.data?.corruptFiles).toBeUndefined()
    })

    it('returns corruptFiles for the corrupt status', async () => {
      await fs.mkdir(path.join(taskDir, 'corrupt'), { recursive: true })
      await fs.writeFile(path.join(taskDir, 'corrupt', 'bad.json'), 'not json {{{', 'utf-8')

      const result = await listTasksHandler(ctx, req, { status: 'corrupt' })

      expect(result.ok).toBe(true)
      expect(result.data?.tasks).toBeUndefined()
      expect(result.data?.corruptFiles).toHaveLength(1)
      expect(result.data?.corruptFiles?.[0].fileName).toBe('bad.json')
    })

    it('rejects an unknown status at the validation layer', () => {
      const validationResult = ADMIN_ROUTES.listTasks.validate({
        params: { status: 'bogus' },
      })

      expect(validationResult.ok).toBe(false)
    })
  })

  describe('POST /admin/tasks/:taskId/retry', () => {
    it('requeues a failed task and returns a fresh newTaskId', async () => {
      const id = await enqueueTask(taskDir, { action: 'push-branch', payload: {} })
      await dequeueTask(taskDir)
      await failTask(taskDir, id, 'boom')

      const result = await retryTaskHandler(ctx, req, { taskId: id })

      expect(result.ok).toBe(true)
      expect(result.status).toBe(200)
      expect(result.data?.newTaskId).toBeTruthy()
      expect(result.data?.newTaskId).not.toBe(id)

      const pendingPath = path.join(taskDir, 'pending', `${result.data?.newTaskId}.json`)
      await expect(fs.stat(pendingPath)).resolves.toBeTruthy()
    })

    it('returns 404 when the task is not in failed/', async () => {
      const result = await retryTaskHandler(ctx, req, { taskId: 'does-not-exist' })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(404)
    })

    it('returns 409 for a garbage failed task file', async () => {
      await fs.mkdir(path.join(taskDir, 'failed'), { recursive: true })
      await fs.writeFile(path.join(taskDir, 'failed', 'garbage.json'), 'not json {{{', 'utf-8')

      const result = await retryTaskHandler(ctx, req, { taskId: 'garbage' })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(409)
    })
  })

  describe('DELETE /admin/tasks/:status/:fileName', () => {
    it('removes a task file from failed/', async () => {
      const id = await enqueueTask(taskDir, { action: 'push-branch', payload: {} })
      await dequeueTask(taskDir)
      await failTask(taskDir, id, 'boom')

      const result = await deleteTaskHandler(ctx, req, {
        status: 'failed',
        fileName: `${id}.json`,
      })

      expect(result.ok).toBe(true)
      expect(result.data).toEqual({ deleted: true })
      await expect(fs.stat(path.join(taskDir, 'failed', `${id}.json`))).rejects.toThrow()
    })

    it('removes a task file from corrupt/', async () => {
      await fs.mkdir(path.join(taskDir, 'corrupt'), { recursive: true })
      await fs.writeFile(path.join(taskDir, 'corrupt', 'bad.json'), 'not json {{{', 'utf-8')

      const result = await deleteTaskHandler(ctx, req, {
        status: 'corrupt',
        fileName: 'bad.json',
      })

      expect(result.ok).toBe(true)
      await expect(fs.stat(path.join(taskDir, 'corrupt', 'bad.json'))).rejects.toThrow()
    })

    it('returns 404 when the task file is missing', async () => {
      const result = await deleteTaskHandler(ctx, req, {
        status: 'pending',
        fileName: 'does-not-exist.json',
      })

      expect(result.ok).toBe(false)
      expect(result.status).toBe(404)
    })

    it('rejects processing and completed at the validation layer', () => {
      for (const status of ['processing', 'completed']) {
        const validationResult = ADMIN_ROUTES.deleteTask.validate({
          params: { status, fileName: 'x.json' },
        })
        expect(validationResult.ok).toBe(false)
      }
    })

    it('rejects traversal/invalid fileNames at the validation layer', () => {
      for (const fileName of ['../../x.json', 'a/b.json', 'x.txt', 'a\\b.json']) {
        const validationResult = ADMIN_ROUTES.deleteTask.validate({
          params: { status: 'failed', fileName },
        })
        expect(validationResult.ok).toBe(false)
      }
    })
  })

  describe('guard coverage', () => {
    it('every admin route is under /admin and 403s for a non-admin user', async () => {
      const nonAdminReq: ApiRequest = { user: createMockUser('user'), body: {} }

      // The guard runs before any handler-specific params are touched, so a
      // single superset object (covering every route's param shape) works
      // for all of them — the guard 403s before params ever matter.
      const supersetParams = {
        status: 'pending' as const,
        limit: 1,
        taskId: 'x',
        fileName: 'x.json',
      }

      for (const route of Object.values(ADMIN_ROUTES)) {
        expect(route.path.startsWith('/admin')).toBe(true)

        const result = await route.handler(ctx, nonAdminReq, supersetParams)

        expect(result.ok).toBe(false)
        expect(result.status).toBe(403)
      }
    })
  })
})
