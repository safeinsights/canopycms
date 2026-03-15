import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { enqueueTask, dequeueTask, completeTask, failTask, getTaskResult } from './task-queue'

describe('Task Queue', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-taskq-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  describe('enqueueTask', () => {
    it('creates a pending task file', async () => {
      const id = await enqueueTask(tmpDir, {
        action: 'push-and-create-pr',
        payload: { branch: 'feature-1', title: 'New feature' },
      })

      expect(id).toBeTruthy()

      const filePath = path.join(tmpDir, 'pending', `${id}.json`)
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(content.id).toBe(id)
      expect(content.action).toBe('push-and-create-pr')
      expect(content.payload.branch).toBe('feature-1')
      expect(content.status).toBe('pending')
      expect(content.createdAt).toBeTruthy()
    })

    it('creates unique IDs for multiple tasks', async () => {
      const id1 = await enqueueTask(tmpDir, { action: 'push-branch', payload: {} })
      const id2 = await enqueueTask(tmpDir, { action: 'push-branch', payload: {} })
      expect(id1).not.toBe(id2)
    })
  })

  describe('dequeueTask', () => {
    it('returns the oldest pending task', async () => {
      const id1 = await enqueueTask(tmpDir, { action: 'push-branch', payload: { n: 1 } })
      await enqueueTask(tmpDir, { action: 'push-branch', payload: { n: 2 } })

      const task = await dequeueTask(tmpDir)
      expect(task).not.toBeNull()
      expect(task!.id).toBe(id1)
      expect(task!.status).toBe('processing')
    })

    it('moves task from pending to processing', async () => {
      const id = await enqueueTask(tmpDir, { action: 'push-branch', payload: {} })

      await dequeueTask(tmpDir)

      // Should not be in pending
      await expect(fs.stat(path.join(tmpDir, 'pending', `${id}.json`))).rejects.toThrow()
      // Should be in processing
      const stat = await fs.stat(path.join(tmpDir, 'processing', `${id}.json`))
      expect(stat.isFile()).toBe(true)
    })

    it('returns null when no pending tasks', async () => {
      const task = await dequeueTask(tmpDir)
      expect(task).toBeNull()
    })

    it('returns null when pending directory does not exist', async () => {
      const task = await dequeueTask(path.join(tmpDir, 'nonexistent'))
      expect(task).toBeNull()
    })
  })

  describe('completeTask', () => {
    it('moves task from processing to completed with result', async () => {
      const id = await enqueueTask(tmpDir, {
        action: 'push-and-create-pr',
        payload: { branch: 'feat' },
      })
      await dequeueTask(tmpDir)

      await completeTask(tmpDir, id, { prUrl: 'https://github.com/pr/1', prNumber: 1 })

      // Should be in completed
      const filePath = path.join(tmpDir, 'completed', `${id}.json`)
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(content.status).toBe('completed')
      expect(content.result.prUrl).toBe('https://github.com/pr/1')
      expect(content.completedAt).toBeTruthy()

      // Should not be in processing
      await expect(fs.stat(path.join(tmpDir, 'processing', `${id}.json`))).rejects.toThrow()
    })
  })

  describe('failTask', () => {
    it('moves task from processing to failed with error', async () => {
      const id = await enqueueTask(tmpDir, {
        action: 'push-and-create-pr',
        payload: {},
      })
      await dequeueTask(tmpDir)

      await failTask(tmpDir, id, 'GitHub API rate limited')

      const filePath = path.join(tmpDir, 'failed', `${id}.json`)
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(content.status).toBe('failed')
      expect(content.error).toBe('GitHub API rate limited')
      expect(content.completedAt).toBeTruthy()
    })
  })

  describe('getTaskResult', () => {
    it('finds completed task', async () => {
      const id = await enqueueTask(tmpDir, { action: 'push-branch', payload: {} })
      await dequeueTask(tmpDir)
      await completeTask(tmpDir, id, { pushed: true })

      const result = await getTaskResult(tmpDir, id)
      expect(result).not.toBeNull()
      expect(result!.status).toBe('completed')
      expect(result!.result).toEqual({ pushed: true })
    })

    it('finds failed task', async () => {
      const id = await enqueueTask(tmpDir, { action: 'push-branch', payload: {} })
      await dequeueTask(tmpDir)
      await failTask(tmpDir, id, 'error')

      const result = await getTaskResult(tmpDir, id)
      expect(result!.status).toBe('failed')
    })

    it('finds pending task', async () => {
      const id = await enqueueTask(tmpDir, { action: 'push-branch', payload: {} })

      const result = await getTaskResult(tmpDir, id)
      expect(result!.status).toBe('pending')
    })

    it('finds processing task', async () => {
      const id = await enqueueTask(tmpDir, { action: 'push-branch', payload: {} })
      await dequeueTask(tmpDir)

      const result = await getTaskResult(tmpDir, id)
      expect(result!.status).toBe('processing')
    })

    it('returns null for unknown task', async () => {
      const result = await getTaskResult(tmpDir, 'nonexistent-id')
      expect(result).toBeNull()
    })
  })

  describe('full lifecycle', () => {
    it('enqueue → dequeue → complete', async () => {
      const id = await enqueueTask(tmpDir, {
        action: 'push-and-create-pr',
        payload: { branch: 'feature', title: 'New PR' },
      })

      const task = await dequeueTask(tmpDir)
      expect(task!.id).toBe(id)
      expect(task!.action).toBe('push-and-create-pr')

      await completeTask(tmpDir, id, { prUrl: 'https://github.com/pr/42' })

      const result = await getTaskResult(tmpDir, id)
      expect(result!.status).toBe('completed')
      expect(result!.result!.prUrl).toBe('https://github.com/pr/42')

      // Queue should be empty
      const next = await dequeueTask(tmpDir)
      expect(next).toBeNull()
    })

    it('enqueue → dequeue → fail', async () => {
      const id = await enqueueTask(tmpDir, {
        action: 'push-branch',
        payload: { branch: 'broken' },
      })

      await dequeueTask(tmpDir)
      await failTask(tmpDir, id, 'Remote rejected push')

      const result = await getTaskResult(tmpDir, id)
      expect(result!.status).toBe('failed')
      expect(result!.error).toBe('Remote rejected push')
    })
  })
})
