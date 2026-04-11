/**
 * File-based persistent task queue.
 *
 * Tasks are JSON files organized in subdirectories by status:
 *   pending/      — ready to be picked up
 *   processing/   — currently being executed
 *   completed/    — finished successfully
 *   failed/       — permanently failed (exhausted retries)
 *   corrupt/      — unreadable files moved here for inspection
 *
 * Designed for shared filesystems (EFS/NFS) where one process enqueues
 * and another dequeues. No external dependencies — only Node.js stdlib.
 *
 * IMPORTANT: Single-consumer only. The dequeue operation is not atomic across
 * processes — the worker lock (acquireLock) ensures only one consumer runs at
 * a time. Do not run multiple dequeue consumers concurrently.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Task, TaskStatus, QueueStats, TaskQueueLogger } from './types'

const DEFAULT_MAX_RETRIES = 3

// Silent no-op logger
const nullLogger: TaskQueueLogger = { debug: () => {} }

import { atomicWriteFile } from '../utils/atomic-write'

// Local helper — only stdlib dependency, keeps task-queue easy to extract.
function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

// ============================================================================
// Core queue operations
// ============================================================================

/**
 * Enqueue a task. Writes a JSON file to pending/{id}.json.
 * Returns the generated task ID.
 */
export async function enqueueTask(
  taskDir: string,
  task: {
    action: string
    payload: Record<string, unknown>
    maxRetries?: number
  },
  logger: TaskQueueLogger = nullLogger,
): Promise<string> {
  const id = crypto.randomUUID()
  const pendingDir = path.join(taskDir, 'pending')

  const queuedTask: Task = {
    id,
    action: task.action,
    payload: task.payload,
    status: 'pending',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: task.maxRetries ?? DEFAULT_MAX_RETRIES,
  }

  const filePath = path.join(pendingDir, `${id}.json`)
  await atomicWriteFile(filePath, JSON.stringify(queuedTask, null, 2))
  logger.debug('Enqueued task', { id, action: task.action })
  return id
}

/**
 * Dequeue the next pending task (oldest first).
 * Moves the task file from pending/ to processing/.
 * Returns null if no tasks are ready.
 *
 * - Skips tasks whose `retryAfter` is in the future.
 * - Moves corrupt JSON files to corrupt/.
 * - Skips tasks that already exist in completed/ or failed/ (crash dedup).
 */
export async function dequeueTask(
  taskDir: string,
  logger: TaskQueueLogger = nullLogger,
): Promise<Task | null> {
  const pendingDir = path.join(taskDir, 'pending')
  const processingDir = path.join(taskDir, 'processing')

  let files: string[]
  try {
    files = await fs.readdir(pendingDir)
  } catch {
    return null
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json'))
  if (jsonFiles.length === 0) return null

  const now = Date.now()

  const tasks: { fileName: string; task: Task }[] = []
  for (const fileName of jsonFiles) {
    try {
      const content = await fs.readFile(path.join(pendingDir, fileName), 'utf-8')
      const task = parseTaskJson(content)
      if (!task) {
        await moveToCorrupt(taskDir, pendingDir, fileName, 'Invalid JSON', logger)
        continue
      }
      if (task.retryAfter && new Date(task.retryAfter).getTime() > now) {
        continue
      }
      tasks.push({ fileName, task })
    } catch (err) {
      if (isNotFoundError(err)) continue
      throw err
    }
  }
  if (tasks.length === 0) return null

  // FIFO with stable tiebreaker (task ID) to prevent indeterminate order
  // when tasks share the same millisecond timestamp
  tasks.sort(
    (a, b) =>
      a.task.createdAt.localeCompare(b.task.createdAt) || a.task.id.localeCompare(b.task.id),
  )
  // Dedup: if a task already finished (crash between write-result and unlink-processing),
  // clean up the stale pending copy and try the next task in the sorted list.
  for (const { fileName, task } of tasks) {
    if (await taskExistsIn(taskDir, task.id, ['completed', 'failed'])) {
      await fs.unlink(path.join(pendingDir, fileName)).catch(() => {})
      logger.debug('Skipped already-finished task', { id: task.id })
      continue
    }

    const sourcePath = path.join(pendingDir, fileName)
    const destPath = path.join(processingDir, fileName)

    try {
      task.status = 'processing'
      await atomicWriteFile(destPath, JSON.stringify(task, null, 2))
      await fs.unlink(sourcePath)
      logger.debug('Dequeued task', { id: task.id, action: task.action })
      return task
    } catch (err) {
      if (isNotFoundError(err)) continue
      throw err
    }
  }

  return null
}

/**
 * Mark a task as completed. Moves from processing/ to completed/.
 */
export async function completeTask(
  taskDir: string,
  taskId: string,
  result: Record<string, unknown>,
  logger: TaskQueueLogger = nullLogger,
): Promise<void> {
  const processingPath = path.join(taskDir, 'processing', `${taskId}.json`)
  const completedDir = path.join(taskDir, 'completed')
  const completedPath = path.join(completedDir, `${taskId}.json`)

  let task: Task
  try {
    const content = await fs.readFile(processingPath, 'utf-8')
    const parsed = parseTaskJson(content)
    if (!parsed) {
      logger.debug('Corrupt task file in processing, removing', { id: taskId })
      await fs.unlink(processingPath).catch(() => {})
      return
    }
    task = parsed
  } catch (err) {
    if (isNotFoundError(err)) return
    throw err
  }

  task.status = 'completed'
  task.completedAt = new Date().toISOString()
  task.result = result

  await atomicWriteFile(completedPath, JSON.stringify(task, null, 2))
  await fs.unlink(processingPath).catch(() => {})
  logger.debug('Completed task', { id: taskId })
}

/**
 * Mark a task as permanently failed. Moves from processing/ to failed/.
 */
export async function failTask(
  taskDir: string,
  taskId: string,
  error: string,
  logger: TaskQueueLogger = nullLogger,
): Promise<void> {
  const processingPath = path.join(taskDir, 'processing', `${taskId}.json`)
  const failedDir = path.join(taskDir, 'failed')
  const failedPath = path.join(failedDir, `${taskId}.json`)

  let task: Task
  try {
    const content = await fs.readFile(processingPath, 'utf-8')
    const parsed = parseTaskJson(content)
    if (!parsed) {
      logger.debug('Corrupt task file in processing, removing', { id: taskId })
      await fs.unlink(processingPath).catch(() => {})
      return
    }
    task = parsed
  } catch (err) {
    if (isNotFoundError(err)) return
    throw err
  }

  task.status = 'failed'
  task.completedAt = new Date().toISOString()
  task.error = error

  await atomicWriteFile(failedPath, JSON.stringify(task, null, 2))
  await fs.unlink(processingPath).catch(() => {})
  logger.debug('Failed task', { id: taskId, error })
}

/**
 * Retry a task with exponential backoff.
 * Moves from processing/ back to pending/ with incremented retryCount
 * and a retryAfter timestamp. Backoff: 5s → 10s → 20s → 40s → 60s cap.
 */
export async function retryTask(
  taskDir: string,
  taskId: string,
  error: string,
  logger: TaskQueueLogger = nullLogger,
): Promise<void> {
  const processingPath = path.join(taskDir, 'processing', `${taskId}.json`)
  const pendingDir = path.join(taskDir, 'pending')
  const pendingPath = path.join(pendingDir, `${taskId}.json`)

  let task: Task
  try {
    const content = await fs.readFile(processingPath, 'utf-8')
    const parsed = parseTaskJson(content)
    if (!parsed) {
      logger.debug('Corrupt task file in processing, removing', { id: taskId })
      await fs.unlink(processingPath).catch(() => {})
      return
    }
    task = parsed
  } catch (err) {
    if (isNotFoundError(err)) return
    throw err
  }

  const retryCount = (task.retryCount ?? 0) + 1
  const backoffMs = Math.min(5000 * Math.pow(2, retryCount - 1), 60_000)

  task.status = 'pending'
  task.retryCount = retryCount
  task.retryAfter = new Date(Date.now() + backoffMs).toISOString()
  task.error = error

  await atomicWriteFile(pendingPath, JSON.stringify(task, null, 2))
  await fs.unlink(processingPath).catch(() => {})
  logger.debug('Retrying task', { id: taskId, retryCount, backoffMs })
}

// ============================================================================
// Recovery & maintenance
// ============================================================================

/**
 * Recover orphaned tasks stuck in processing/.
 * Moves tasks whose file mtime is older than maxAgeMs back to pending/.
 * Call on worker startup to handle crash recovery.
 *
 * Skips tasks that already exist in completed/ or failed/ — these are
 * leftovers from a crash between writing the result and unlinking the
 * processing copy.
 */
export async function recoverOrphanedTasks(
  taskDir: string,
  maxAgeMs = 5 * 60_000,
  logger: TaskQueueLogger = nullLogger,
): Promise<number> {
  const processingDir = path.join(taskDir, 'processing')
  const pendingDir = path.join(taskDir, 'pending')

  let files: string[]
  try {
    files = await fs.readdir(processingDir)
  } catch {
    return 0
  }

  const now = Date.now()
  let recovered = 0

  for (const fileName of files.filter((f) => f.endsWith('.json'))) {
    const filePath = path.join(processingDir, fileName)
    try {
      const stat = await fs.stat(filePath)
      if (now - stat.mtimeMs >= maxAgeMs) {
        const content = await fs.readFile(filePath, 'utf-8')
        const task = parseTaskJson(content)
        if (!task) {
          await moveToCorrupt(
            taskDir,
            processingDir,
            fileName,
            'Invalid JSON during recovery',
            logger,
          )
          continue
        }

        if (await taskExistsIn(taskDir, task.id, ['completed', 'failed'])) {
          await fs.unlink(filePath).catch(() => {})
          logger.debug('Cleaned up orphaned task (already finished)', {
            id: task.id,
          })
          continue
        }

        task.status = 'pending'
        await atomicWriteFile(path.join(pendingDir, fileName), JSON.stringify(task, null, 2))
        await fs.unlink(filePath)
        logger.debug('Recovered orphaned task', {
          id: task.id,
          action: task.action,
        })
        recovered++
      }
    } catch (err) {
      if (isNotFoundError(err)) continue
      logger.debug('Failed to recover task', { fileName })
    }
  }

  return recovered
}

/**
 * Delete old task files from completed/ and failed/.
 * Default retention: 30 days.
 */
export async function cleanupOldTasks(
  taskDir: string,
  maxAgeMs = 30 * 24 * 60 * 60_000,
  logger: TaskQueueLogger = nullLogger,
): Promise<number> {
  const now = Date.now()
  let cleaned = 0

  for (const subdir of ['completed', 'failed']) {
    const dir = path.join(taskDir, subdir)
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch {
      continue
    }

    for (const fileName of files.filter((f) => f.endsWith('.json'))) {
      try {
        const filePath = path.join(dir, fileName)
        const stat = await fs.stat(filePath)
        if (now - stat.mtimeMs >= maxAgeMs) {
          await fs.unlink(filePath)
          cleaned++
        }
      } catch {
        // File already gone or unreadable
      }
    }
  }

  if (cleaned > 0) {
    logger.debug('Cleaned up old tasks', { cleaned })
  }
  return cleaned
}

// ============================================================================
// Query operations (for status UIs, monitoring)
// ============================================================================

/**
 * Get a specific task by ID. Searches all status directories.
 */
export async function getTask(taskDir: string, taskId: string): Promise<Task | null> {
  for (const subdir of ['completed', 'failed', 'processing', 'pending']) {
    const filePath = path.join(taskDir, subdir, `${taskId}.json`)
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      return parseTaskJson(content)
    } catch {
      continue
    }
  }
  return null
}

/**
 * List tasks in a specific status directory.
 * Returns tasks sorted by createdAt (oldest first).
 * Use `limit` to cap the number of results.
 */
export async function listTasks(
  taskDir: string,
  status: TaskStatus | 'corrupt',
  limit = 100,
): Promise<Task[]> {
  const dir = path.join(taskDir, status)
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch {
    return []
  }

  const tasks: Task[] = []
  for (const fileName of files.filter((f) => f.endsWith('.json'))) {
    if (tasks.length >= limit) break
    try {
      const content = await fs.readFile(path.join(dir, fileName), 'utf-8')
      const task = parseTaskJson(content)
      if (task) tasks.push(task)
    } catch {
      continue
    }
  }

  tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return tasks
}

/**
 * Get counts of tasks in each status directory.
 */
export async function getQueueStats(taskDir: string): Promise<QueueStats> {
  const stats: QueueStats = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    corrupt: 0,
  }

  for (const status of ['pending', 'processing', 'completed', 'failed', 'corrupt'] as const) {
    const dir = path.join(taskDir, status)
    try {
      const files = await fs.readdir(dir)
      stats[status] = files.filter((f) => f.endsWith('.json')).length
    } catch {
      // Directory doesn't exist — count stays 0
    }
  }

  return stats
}

// ============================================================================
// Internal helpers
// ============================================================================

/** Parse JSON into a Task, returning null if invalid. */
function parseTaskJson(content: string): Task | null {
  try {
    const parsed = JSON.parse(content) as Task
    if (typeof parsed.id !== 'string' || typeof parsed.action !== 'string') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/** Check if a task file exists in any of the specified subdirectories. */
async function taskExistsIn(taskDir: string, taskId: string, subdirs: string[]): Promise<boolean> {
  for (const subdir of subdirs) {
    try {
      await fs.stat(path.join(taskDir, subdir, `${taskId}.json`))
      return true
    } catch {
      // Not in this subdir
    }
  }
  return false
}

/** Move a corrupt file to corrupt/ for inspection. */
async function moveToCorrupt(
  taskDir: string,
  sourceDir: string,
  fileName: string,
  reason: string,
  logger: TaskQueueLogger,
): Promise<void> {
  const corruptDir = path.join(taskDir, 'corrupt')
  try {
    await fs.mkdir(corruptDir, { recursive: true })
    await fs.rename(path.join(sourceDir, fileName), path.join(corruptDir, fileName))
    logger.debug('Moved corrupt task file', { fileName, reason })
  } catch {
    await fs.unlink(path.join(sourceDir, fileName)).catch(() => {})
  }
}
