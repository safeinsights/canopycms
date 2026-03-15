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
  getTask,
  listTasks,
  getQueueStats,
  recoverOrphanedTasks,
  cleanupOldTasks,
} from './task-queue'

describe('Task Queue', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskq-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // ========================================================================
  // Core lifecycle
  // ========================================================================

  describe('enqueue', () => {
    it('creates a pending task file with correct fields', async () => {
      const id = await enqueueTask(tmpDir, {
        action: 'deploy',
        payload: { env: 'prod' },
      })

      const filePath = path.join(tmpDir, 'pending', `${id}.json`)
      const task = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      expect(task.id).toBe(id)
      expect(task.action).toBe('deploy')
      expect(task.payload).toEqual({ env: 'prod' })
      expect(task.status).toBe('pending')
      expect(task.retryCount).toBe(0)
      expect(task.maxRetries).toBe(3)
      expect(task.createdAt).toBeTruthy()
    })

    it('generates unique IDs', async () => {
      const id1 = await enqueueTask(tmpDir, { action: 'a', payload: {} })
      const id2 = await enqueueTask(tmpDir, { action: 'b', payload: {} })
      expect(id1).not.toBe(id2)
    })

    it('accepts any string as action (generic, not a fixed union)', async () => {
      const id = await enqueueTask(tmpDir, {
        action: 'custom-user-defined-action',
        payload: { custom: true },
      })
      const task = await getTask(tmpDir, id)
      expect(task!.action).toBe('custom-user-defined-action')
    })

    it('allows custom maxRetries', async () => {
      const id = await enqueueTask(tmpDir, {
        action: 'fragile',
        payload: {},
        maxRetries: 10,
      })
      const task = await getTask(tmpDir, id)
      expect(task!.maxRetries).toBe(10)
    })
  })

  describe('dequeue', () => {
    it('returns oldest task first (FIFO)', async () => {
      const id1 = await enqueueTask(tmpDir, { action: 'first', payload: {} })
      await new Promise((r) => setTimeout(r, 5))
      await enqueueTask(tmpDir, { action: 'second', payload: {} })

      const task = await dequeueTask(tmpDir)
      expect(task!.id).toBe(id1)
      expect(task!.status).toBe('processing')
    })

    it('moves task from pending/ to processing/', async () => {
      const id = await enqueueTask(tmpDir, { action: 'x', payload: {} })
      await dequeueTask(tmpDir)

      await expect(fs.stat(path.join(tmpDir, 'pending', `${id}.json`))).rejects.toThrow()
      const stat = await fs.stat(path.join(tmpDir, 'processing', `${id}.json`))
      expect(stat.isFile()).toBe(true)
    })

    it('returns null when queue is empty', async () => {
      expect(await dequeueTask(tmpDir)).toBeNull()
    })

    it('returns null when pending directory does not exist', async () => {
      expect(await dequeueTask(path.join(tmpDir, 'nonexistent'))).toBeNull()
    })
  })

  describe('complete', () => {
    it('moves task to completed/ with result and timestamp', async () => {
      const id = await enqueueTask(tmpDir, { action: 'build', payload: {} })
      await dequeueTask(tmpDir)
      await completeTask(tmpDir, id, { url: 'https://example.com' })

      const task = JSON.parse(
        await fs.readFile(path.join(tmpDir, 'completed', `${id}.json`), 'utf-8'),
      )
      expect(task.status).toBe('completed')
      expect(task.result.url).toBe('https://example.com')
      expect(task.completedAt).toBeTruthy()

      await expect(fs.stat(path.join(tmpDir, 'processing', `${id}.json`))).rejects.toThrow()
    })
  })

  describe('fail', () => {
    it('moves task to failed/ with error and timestamp', async () => {
      const id = await enqueueTask(tmpDir, { action: 'deploy', payload: {} })
      await dequeueTask(tmpDir)
      await failTask(tmpDir, id, 'Connection refused')

      const task = JSON.parse(await fs.readFile(path.join(tmpDir, 'failed', `${id}.json`), 'utf-8'))
      expect(task.status).toBe('failed')
      expect(task.error).toBe('Connection refused')
      expect(task.completedAt).toBeTruthy()
    })
  })

  describe('full lifecycle', () => {
    it('enqueue → dequeue → complete', async () => {
      const id = await enqueueTask(tmpDir, { action: 'send-email', payload: { to: 'a@b.com' } })
      const task = await dequeueTask(tmpDir)
      expect(task!.id).toBe(id)

      await completeTask(tmpDir, id, { sent: true })
      const result = await getTask(tmpDir, id)
      expect(result!.status).toBe('completed')

      expect(await dequeueTask(tmpDir)).toBeNull()
    })

    it('enqueue → dequeue → fail', async () => {
      const id = await enqueueTask(tmpDir, { action: 'deploy', payload: {} })
      await dequeueTask(tmpDir)
      await failTask(tmpDir, id, 'Timeout')

      const result = await getTask(tmpDir, id)
      expect(result!.status).toBe('failed')
      expect(result!.error).toBe('Timeout')
    })
  })

  // ========================================================================
  // Issue 2: Retry with exponential backoff
  // ========================================================================

  describe('retry', () => {
    it('moves task back to pending with incremented retryCount', async () => {
      const id = await enqueueTask(tmpDir, { action: 'push', payload: {} })
      await dequeueTask(tmpDir)
      await retryTask(tmpDir, id, 'Transient error')

      const task = JSON.parse(
        await fs.readFile(path.join(tmpDir, 'pending', `${id}.json`), 'utf-8'),
      )
      expect(task.status).toBe('pending')
      expect(task.retryCount).toBe(1)
      expect(task.retryAfter).toBeTruthy()
      expect(task.error).toBe('Transient error')

      await expect(fs.stat(path.join(tmpDir, 'processing', `${id}.json`))).rejects.toThrow()
    })

    it('applies exponential backoff (5s, 10s, 20s, cap 60s)', async () => {
      const id = await enqueueTask(tmpDir, { action: 'push', payload: {} })

      // First retry → 5s backoff
      await dequeueTask(tmpDir)
      const t0 = Date.now()
      await retryTask(tmpDir, id, 'err')
      let task = JSON.parse(await fs.readFile(path.join(tmpDir, 'pending', `${id}.json`), 'utf-8'))
      const delay1 = new Date(task.retryAfter).getTime() - t0
      expect(delay1).toBeGreaterThanOrEqual(4000)
      expect(delay1).toBeLessThanOrEqual(8000)

      // Manually make retryAfter past so we can dequeue again
      task.retryAfter = new Date(Date.now() - 1000).toISOString()
      await fs.writeFile(path.join(tmpDir, 'pending', `${id}.json`), JSON.stringify(task), 'utf-8')

      // Second retry → 10s backoff
      await dequeueTask(tmpDir)
      const t1 = Date.now()
      await retryTask(tmpDir, id, 'err2')
      task = JSON.parse(await fs.readFile(path.join(tmpDir, 'pending', `${id}.json`), 'utf-8'))
      expect(task.retryCount).toBe(2)
      const delay2 = new Date(task.retryAfter).getTime() - t1
      expect(delay2).toBeGreaterThanOrEqual(8000)
      expect(delay2).toBeLessThanOrEqual(15000)
    })

    it('dequeue skips tasks whose retryAfter is in the future', async () => {
      const id = await enqueueTask(tmpDir, { action: 'push', payload: {} })

      const filePath = path.join(tmpDir, 'pending', `${id}.json`)
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      content.retryAfter = new Date(Date.now() + 60_000).toISOString()
      await fs.writeFile(filePath, JSON.stringify(content), 'utf-8')

      expect(await dequeueTask(tmpDir)).toBeNull()
    })

    it('dequeue picks up tasks whose retryAfter is in the past', async () => {
      const id = await enqueueTask(tmpDir, { action: 'push', payload: {} })

      const filePath = path.join(tmpDir, 'pending', `${id}.json`)
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      content.retryAfter = new Date(Date.now() - 1000).toISOString()
      await fs.writeFile(filePath, JSON.stringify(content), 'utf-8')

      const task = await dequeueTask(tmpDir)
      expect(task!.id).toBe(id)
    })
  })

  // ========================================================================
  // Issue 1: Crash dedup — prevent duplicate execution
  // ========================================================================

  describe('crash dedup', () => {
    it('dequeue skips task that already exists in completed/', async () => {
      const id = await enqueueTask(tmpDir, { action: 'push', payload: {} })

      // Simulate crash: task exists in both pending and completed
      await fs.mkdir(path.join(tmpDir, 'completed'), { recursive: true })
      await fs.writeFile(
        path.join(tmpDir, 'completed', `${id}.json`),
        JSON.stringify({ id, action: 'push', payload: {}, status: 'completed' }),
        'utf-8',
      )

      const task = await dequeueTask(tmpDir)
      expect(task).toBeNull()
      // Pending copy should be cleaned up
      await expect(fs.stat(path.join(tmpDir, 'pending', `${id}.json`))).rejects.toThrow()
    })

    it('dequeue skips task that already exists in failed/', async () => {
      const id = await enqueueTask(tmpDir, { action: 'push', payload: {} })

      await fs.mkdir(path.join(tmpDir, 'failed'), { recursive: true })
      await fs.writeFile(
        path.join(tmpDir, 'failed', `${id}.json`),
        JSON.stringify({ id, action: 'push', payload: {}, status: 'failed' }),
        'utf-8',
      )

      expect(await dequeueTask(tmpDir)).toBeNull()
    })

    it('orphan recovery skips tasks already in completed/ (crash between write and unlink)', async () => {
      const id = await enqueueTask(tmpDir, { action: 'push', payload: {} })
      await dequeueTask(tmpDir)

      // Simulate crash: task in both processing/ and completed/
      await fs.mkdir(path.join(tmpDir, 'completed'), { recursive: true })
      await fs.writeFile(
        path.join(tmpDir, 'completed', `${id}.json`),
        JSON.stringify({ id, status: 'completed' }),
        'utf-8',
      )

      await new Promise((r) => setTimeout(r, 10))
      const recovered = await recoverOrphanedTasks(tmpDir, 0)
      expect(recovered).toBe(0)
      // Processing copy should be cleaned up
      await expect(fs.stat(path.join(tmpDir, 'processing', `${id}.json`))).rejects.toThrow()
    })
  })

  // ========================================================================
  // Issue 4: Corrupted JSON handling
  // ========================================================================

  describe('corrupt file handling', () => {
    it('dequeue moves corrupt files to corrupt/ and continues', async () => {
      await fs.mkdir(path.join(tmpDir, 'pending'), { recursive: true })
      await fs.writeFile(path.join(tmpDir, 'pending', 'bad.json'), 'not json {{{', 'utf-8')

      const validId = await enqueueTask(tmpDir, { action: 'ok', payload: {} })

      const task = await dequeueTask(tmpDir)
      expect(task!.id).toBe(validId)

      // Corrupt file moved to corrupt/
      await expect(fs.stat(path.join(tmpDir, 'corrupt', 'bad.json'))).resolves.toBeTruthy()
      await expect(fs.stat(path.join(tmpDir, 'pending', 'bad.json'))).rejects.toThrow()
    })

    it('dequeue moves files with missing required fields to corrupt/', async () => {
      await fs.mkdir(path.join(tmpDir, 'pending'), { recursive: true })
      // Valid JSON but missing 'id' field
      await fs.writeFile(
        path.join(tmpDir, 'pending', 'noid.json'),
        JSON.stringify({ action: 'x', payload: {} }),
        'utf-8',
      )

      expect(await dequeueTask(tmpDir)).toBeNull()
      await expect(fs.stat(path.join(tmpDir, 'corrupt', 'noid.json'))).resolves.toBeTruthy()
    })

    it('completeTask handles corrupt processing file gracefully', async () => {
      await fs.mkdir(path.join(tmpDir, 'processing'), { recursive: true })
      await fs.writeFile(path.join(tmpDir, 'processing', 'bad-id.json'), 'corrupt', 'utf-8')

      // Should not throw — just log and remove
      await completeTask(tmpDir, 'bad-id', { result: true })
      await expect(fs.stat(path.join(tmpDir, 'processing', 'bad-id.json'))).rejects.toThrow()
    })

    it('failTask handles corrupt processing file gracefully', async () => {
      await fs.mkdir(path.join(tmpDir, 'processing'), { recursive: true })
      await fs.writeFile(path.join(tmpDir, 'processing', 'bad-id.json'), '{{bad', 'utf-8')

      await failTask(tmpDir, 'bad-id', 'error')
      await expect(fs.stat(path.join(tmpDir, 'processing', 'bad-id.json'))).rejects.toThrow()
    })

    it('retryTask handles corrupt processing file gracefully', async () => {
      await fs.mkdir(path.join(tmpDir, 'processing'), { recursive: true })
      await fs.writeFile(path.join(tmpDir, 'processing', 'bad-id.json'), '{{bad', 'utf-8')

      await retryTask(tmpDir, 'bad-id', 'error')
      await expect(fs.stat(path.join(tmpDir, 'processing', 'bad-id.json'))).rejects.toThrow()
    })

    it('recovery moves corrupt processing files to corrupt/', async () => {
      await fs.mkdir(path.join(tmpDir, 'processing'), { recursive: true })
      await fs.writeFile(path.join(tmpDir, 'processing', 'bad.json'), 'broken', 'utf-8')

      await new Promise((r) => setTimeout(r, 10))
      await recoverOrphanedTasks(tmpDir, 0)

      await expect(fs.stat(path.join(tmpDir, 'corrupt', 'bad.json'))).resolves.toBeTruthy()
    })
  })

  // ========================================================================
  // Orphan recovery
  // ========================================================================

  describe('orphan recovery', () => {
    it('moves stale tasks from processing back to pending', async () => {
      const id = await enqueueTask(tmpDir, { action: 'push', payload: {} })
      await dequeueTask(tmpDir)

      await new Promise((r) => setTimeout(r, 10))
      const recovered = await recoverOrphanedTasks(tmpDir, 0)
      expect(recovered).toBe(1)

      const task = JSON.parse(
        await fs.readFile(path.join(tmpDir, 'pending', `${id}.json`), 'utf-8'),
      )
      expect(task.status).toBe('pending')
    })

    it('leaves recent tasks in processing (not stale yet)', async () => {
      await enqueueTask(tmpDir, { action: 'push', payload: {} })
      await dequeueTask(tmpDir)

      const recovered = await recoverOrphanedTasks(tmpDir, 60_000)
      expect(recovered).toBe(0)
    })

    it('returns 0 when processing/ does not exist', async () => {
      expect(await recoverOrphanedTasks(tmpDir)).toBe(0)
    })
  })

  // ========================================================================
  // Issue 6: Cleanup old tasks
  // ========================================================================

  describe('cleanup', () => {
    it('removes old completed and failed tasks', async () => {
      const id1 = await enqueueTask(tmpDir, { action: 'a', payload: {} })
      await new Promise((r) => setTimeout(r, 5))
      const id2 = await enqueueTask(tmpDir, { action: 'b', payload: {} })
      await dequeueTask(tmpDir)
      await completeTask(tmpDir, id1, {})
      await dequeueTask(tmpDir)
      await failTask(tmpDir, id2, 'err')

      await new Promise((r) => setTimeout(r, 10))
      const cleaned = await cleanupOldTasks(tmpDir, 0)
      expect(cleaned).toBe(2)

      await expect(fs.stat(path.join(tmpDir, 'completed', `${id1}.json`))).rejects.toThrow()
      await expect(fs.stat(path.join(tmpDir, 'failed', `${id2}.json`))).rejects.toThrow()
    })

    it('keeps recent tasks', async () => {
      const id = await enqueueTask(tmpDir, { action: 'a', payload: {} })
      await dequeueTask(tmpDir)
      await completeTask(tmpDir, id, {})

      const cleaned = await cleanupOldTasks(tmpDir, 60 * 60_000)
      expect(cleaned).toBe(0)
    })
  })

  // ========================================================================
  // Query APIs (for editor UI)
  // ========================================================================

  describe('getTask', () => {
    it('finds task in any status directory', async () => {
      const id = await enqueueTask(tmpDir, { action: 'push', payload: {} })
      expect((await getTask(tmpDir, id))!.status).toBe('pending')

      await dequeueTask(tmpDir)
      expect((await getTask(tmpDir, id))!.status).toBe('processing')

      await completeTask(tmpDir, id, { ok: true })
      expect((await getTask(tmpDir, id))!.status).toBe('completed')
    })

    it('returns null for unknown task', async () => {
      expect(await getTask(tmpDir, 'nonexistent')).toBeNull()
    })
  })

  describe('listTasks', () => {
    it('returns tasks sorted by createdAt', async () => {
      const id1 = await enqueueTask(tmpDir, { action: 'a', payload: {} })
      await new Promise((r) => setTimeout(r, 5))
      const id2 = await enqueueTask(tmpDir, { action: 'b', payload: {} })

      const tasks = await listTasks(tmpDir, 'pending')
      expect(tasks).toHaveLength(2)
      expect(tasks[0].id).toBe(id1)
      expect(tasks[1].id).toBe(id2)
    })

    it('respects limit parameter', async () => {
      await enqueueTask(tmpDir, { action: 'a', payload: {} })
      await enqueueTask(tmpDir, { action: 'b', payload: {} })
      await enqueueTask(tmpDir, { action: 'c', payload: {} })

      const tasks = await listTasks(tmpDir, 'pending', 2)
      expect(tasks).toHaveLength(2)
    })

    it('returns empty array for nonexistent status directory', async () => {
      expect(await listTasks(tmpDir, 'completed')).toEqual([])
    })
  })

  describe('getQueueStats', () => {
    it('returns counts for each status', async () => {
      const id1 = await enqueueTask(tmpDir, { action: 'a', payload: {} })
      const id2 = await enqueueTask(tmpDir, { action: 'b', payload: {} })
      await enqueueTask(tmpDir, { action: 'c', payload: {} }) // stays pending
      await dequeueTask(tmpDir)
      await completeTask(tmpDir, id1, {})
      await dequeueTask(tmpDir)
      await failTask(tmpDir, id2, 'err')

      const stats = await getQueueStats(tmpDir)
      expect(stats.pending).toBe(1)
      expect(stats.processing).toBe(0)
      expect(stats.completed).toBe(1)
      expect(stats.failed).toBe(1)
      expect(stats.corrupt).toBe(0)
    })

    it('returns all zeros for empty queue', async () => {
      const stats = await getQueueStats(tmpDir)
      expect(stats).toEqual({ pending: 0, processing: 0, completed: 0, failed: 0, corrupt: 0 })
    })
  })

  // ========================================================================
  // Logger interface
  // ========================================================================

  describe('logger', () => {
    it('calls logger.debug when provided', async () => {
      const messages: string[] = []
      const logger = { debug: (msg: string) => messages.push(msg) }

      await enqueueTask(tmpDir, { action: 'x', payload: {} }, logger)
      expect(messages).toContain('Enqueued task')
    })

    it('works silently without a logger', async () => {
      // Should not throw
      const id = await enqueueTask(tmpDir, { action: 'x', payload: {} })
      await dequeueTask(tmpDir)
      await completeTask(tmpDir, id, {})
    })
  })
})
