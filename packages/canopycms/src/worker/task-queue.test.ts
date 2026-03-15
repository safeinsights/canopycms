import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  enqueueTask,
  dequeueTask,
  completeTask,
  failTask,
  retryTask,
  getTaskResult,
  recoverOrphanedTasks,
  cleanupOldTasks,
} from './task-queue'

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
      await new Promise((r) => setTimeout(r, 5)) // Ensure different createdAt timestamp
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

  describe('retryTask', () => {
    it('moves task back to pending with incremented retryCount', async () => {
      const id = await enqueueTask(tmpDir, {
        action: 'push-branch',
        payload: { branch: 'retry-me' },
      })
      await dequeueTask(tmpDir)

      await retryTask(tmpDir, id, 'Transient error')

      // Should be back in pending
      const filePath = path.join(tmpDir, 'pending', `${id}.json`)
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(content.status).toBe('pending')
      expect(content.retryCount).toBe(1)
      expect(content.retryAfter).toBeTruthy()
      expect(content.error).toBe('Transient error')

      // Should not be in processing
      await expect(fs.stat(path.join(tmpDir, 'processing', `${id}.json`))).rejects.toThrow()
    })

    it('sets retryAfter with exponential backoff', async () => {
      const id = await enqueueTask(tmpDir, {
        action: 'push-branch',
        payload: {},
      })
      await dequeueTask(tmpDir)

      const beforeRetry = Date.now()
      await retryTask(tmpDir, id, 'error')

      const content = JSON.parse(
        await fs.readFile(path.join(tmpDir, 'pending', `${id}.json`), 'utf-8'),
      )
      const retryAfterMs = new Date(content.retryAfter).getTime()
      // First retry backoff is 5000ms
      expect(retryAfterMs).toBeGreaterThanOrEqual(beforeRetry + 4000)
      expect(retryAfterMs).toBeLessThanOrEqual(beforeRetry + 10000)
    })
  })

  describe('dequeueTask with retryAfter', () => {
    it('skips tasks whose retryAfter is in the future', async () => {
      const id = await enqueueTask(tmpDir, {
        action: 'push-branch',
        payload: {},
      })

      // Manually set a retryAfter in the future
      const filePath = path.join(tmpDir, 'pending', `${id}.json`)
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      content.retryAfter = new Date(Date.now() + 60_000).toISOString()
      await fs.writeFile(filePath, JSON.stringify(content), 'utf-8')

      const task = await dequeueTask(tmpDir)
      expect(task).toBeNull()
    })

    it('dequeues tasks whose retryAfter is in the past', async () => {
      const id = await enqueueTask(tmpDir, {
        action: 'push-branch',
        payload: {},
      })

      // Set retryAfter to the past
      const filePath = path.join(tmpDir, 'pending', `${id}.json`)
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      content.retryAfter = new Date(Date.now() - 1000).toISOString()
      await fs.writeFile(filePath, JSON.stringify(content), 'utf-8')

      const task = await dequeueTask(tmpDir)
      expect(task).not.toBeNull()
      expect(task!.id).toBe(id)
    })
  })

  describe('dedup detection', () => {
    it('skips dequeue if task already exists in completed', async () => {
      const id = await enqueueTask(tmpDir, {
        action: 'push-branch',
        payload: {},
      })

      // Simulate crash scenario: task in both pending and completed
      await fs.mkdir(path.join(tmpDir, 'completed'), { recursive: true })
      const completedContent = { id, action: 'push-branch', payload: {}, status: 'completed' }
      await fs.writeFile(
        path.join(tmpDir, 'completed', `${id}.json`),
        JSON.stringify(completedContent),
        'utf-8',
      )

      const task = await dequeueTask(tmpDir)
      expect(task).toBeNull()

      // Pending copy should have been cleaned up
      await expect(fs.stat(path.join(tmpDir, 'pending', `${id}.json`))).rejects.toThrow()
    })
  })

  describe('recoverOrphanedTasks', () => {
    it('moves stale tasks from processing back to pending', async () => {
      const id = await enqueueTask(tmpDir, {
        action: 'push-branch',
        payload: {},
      })
      await dequeueTask(tmpDir)

      // Small delay to ensure file mtime is in the past
      await new Promise((r) => setTimeout(r, 10))
      // Recover with maxAge of 0 (treat everything as stale)
      const recovered = await recoverOrphanedTasks(tmpDir, 0)
      expect(recovered).toBe(1)

      // Should be back in pending
      const filePath = path.join(tmpDir, 'pending', `${id}.json`)
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(content.status).toBe('pending')
    })

    it('skips recovery if task already in completed (dedup)', async () => {
      const id = await enqueueTask(tmpDir, {
        action: 'push-branch',
        payload: {},
      })
      await dequeueTask(tmpDir)

      // Simulate: task also in completed (crash between write and unlink)
      await fs.mkdir(path.join(tmpDir, 'completed'), { recursive: true })
      await fs.writeFile(
        path.join(tmpDir, 'completed', `${id}.json`),
        JSON.stringify({ id, status: 'completed' }),
        'utf-8',
      )

      // Small delay to ensure file mtime is in the past
      await new Promise((r) => setTimeout(r, 10))
      const recovered = await recoverOrphanedTasks(tmpDir, 0)
      expect(recovered).toBe(0)

      // Processing copy should be cleaned up
      await expect(fs.stat(path.join(tmpDir, 'processing', `${id}.json`))).rejects.toThrow()
    })
  })

  describe('corrupt file handling', () => {
    it('moves corrupt files to corrupt/ and continues processing', async () => {
      // Write a corrupt file
      await fs.mkdir(path.join(tmpDir, 'pending'), { recursive: true })
      await fs.writeFile(
        path.join(tmpDir, 'pending', 'bad-task.json'),
        'not valid json {{{{',
        'utf-8',
      )

      // Also enqueue a valid task
      const validId = await enqueueTask(tmpDir, {
        action: 'push-branch',
        payload: {},
      })

      const task = await dequeueTask(tmpDir)
      expect(task).not.toBeNull()
      expect(task!.id).toBe(validId)

      // Corrupt file should be in corrupt/
      const corruptFile = path.join(tmpDir, 'corrupt', 'bad-task.json')
      await expect(fs.stat(corruptFile)).resolves.toBeTruthy()
    })
  })

  describe('cleanupOldTasks', () => {
    it('removes old completed and failed tasks', async () => {
      const id1 = await enqueueTask(tmpDir, { action: 'push-branch', payload: {} })
      await new Promise((r) => setTimeout(r, 5))
      const id2 = await enqueueTask(tmpDir, { action: 'push-branch', payload: {} })
      await dequeueTask(tmpDir)
      await completeTask(tmpDir, id1, {})
      await dequeueTask(tmpDir)
      await failTask(tmpDir, id2, 'error')

      // Small delay to ensure file mtimes are in the past
      await new Promise((r) => setTimeout(r, 10))
      // Clean with maxAge of 0 (treat everything as old)
      const cleaned = await cleanupOldTasks(tmpDir, 0)
      expect(cleaned).toBe(2)

      await expect(fs.stat(path.join(tmpDir, 'completed', `${id1}.json`))).rejects.toThrow()
      await expect(fs.stat(path.join(tmpDir, 'failed', `${id2}.json`))).rejects.toThrow()
    })

    it('keeps recent tasks', async () => {
      const id = await enqueueTask(tmpDir, { action: 'push-branch', payload: {} })
      await dequeueTask(tmpDir)
      await completeTask(tmpDir, id, {})

      // Clean with 1 hour max age — recent tasks should remain
      const cleaned = await cleanupOldTasks(tmpDir, 60 * 60_000)
      expect(cleaned).toBe(0)

      const filePath = path.join(tmpDir, 'completed', `${id}.json`)
      await expect(fs.stat(filePath)).resolves.toBeTruthy()
    })
  })
})
