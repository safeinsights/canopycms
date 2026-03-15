import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createDebugLogger } from '../utils/debug'
import { isNotFoundError } from '../utils/error'

const log = createDebugLogger({ prefix: 'TaskQueue' })

/**
 * Actions the EC2 worker can execute on behalf of Lambda.
 */
export type TaskAction =
  | 'push-and-create-pr'
  | 'push-and-update-pr'
  | 'convert-to-draft'
  | 'close-pr'
  | 'delete-remote-branch'
  | 'push-branch'

export interface WorkerTask {
  id: string
  action: TaskAction
  payload: Record<string, unknown>
  status: 'pending' | 'processing' | 'completed' | 'failed'
  createdAt: string
  completedAt?: string
  result?: Record<string, unknown>
  error?: string
  /** Number of times this task has been retried (default: 0) */
  retryCount?: number
  /** Maximum retries before permanent failure (default: 3) */
  maxRetries?: number
  /** ISO timestamp — task should not be dequeued before this time */
  retryAfter?: string
}

const DEFAULT_MAX_RETRIES = 3

/**
 * Enqueue a task for the EC2 worker to process.
 * Writes a JSON file to .tasks/pending/{id}.json on EFS.
 */
export async function enqueueTask(
  taskDir: string,
  task: { action: TaskAction; payload: Record<string, unknown> },
): Promise<string> {
  const id = crypto.randomUUID()
  const pendingDir = path.join(taskDir, 'pending')
  await fs.mkdir(pendingDir, { recursive: true })

  const workerTask: WorkerTask = {
    id,
    action: task.action,
    payload: task.payload,
    status: 'pending',
    createdAt: new Date().toISOString(),
    retryCount: 0,
    maxRetries: DEFAULT_MAX_RETRIES,
  }

  const filePath = path.join(pendingDir, `${id}.json`)
  await fs.writeFile(filePath, JSON.stringify(workerTask, null, 2), 'utf-8')
  log.debug('task', 'Enqueued task', { id, action: task.action })
  return id
}

/**
 * Dequeue the next pending task (oldest first).
 * Moves the task file from pending/ to processing/.
 * Returns null if no pending tasks.
 *
 * Skips tasks with a retryAfter timestamp in the future.
 * Skips corrupt JSON files (moves them to corrupt/).
 */
export async function dequeueTask(taskDir: string): Promise<WorkerTask | null> {
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

  // Read all pending tasks and sort by createdAt for FIFO ordering
  const tasks: { fileName: string; task: WorkerTask }[] = []
  for (const fileName of jsonFiles) {
    try {
      const content = await fs.readFile(path.join(pendingDir, fileName), 'utf-8')
      const task = parseTaskJson(content)
      if (!task) {
        await moveToCorrupt(taskDir, pendingDir, fileName, 'Invalid JSON')
        continue
      }
      // Skip tasks whose retryAfter is in the future
      if (task.retryAfter && new Date(task.retryAfter).getTime() > now) {
        continue
      }
      tasks.push({ fileName, task })
    } catch (err) {
      if (isNotFoundError(err)) continue // Race condition — another worker got it
      throw err
    }
  }
  if (tasks.length === 0) return null

  // Sort by createdAt for FIFO, with task ID as stable tiebreaker
  // (prevents indeterminate order when tasks have identical timestamps)
  tasks.sort(
    (a, b) =>
      a.task.createdAt.localeCompare(b.task.createdAt) || a.task.id.localeCompare(b.task.id),
  )
  const { fileName, task } = tasks[0]

  // Dedup check: if this task was already completed or failed (crash recovery scenario),
  // just clean up the pending copy
  if (await taskExistsIn(taskDir, task.id, ['completed', 'failed'])) {
    try {
      await fs.unlink(path.join(pendingDir, fileName))
      log.debug('task', 'Skipped already-completed task', { id: task.id })
    } catch {
      // Already gone
    }
    return null
  }

  const sourcePath = path.join(pendingDir, fileName)
  const destPath = path.join(processingDir, fileName)

  try {
    task.status = 'processing'

    await fs.mkdir(processingDir, { recursive: true })
    await fs.writeFile(destPath, JSON.stringify(task, null, 2), 'utf-8')
    await fs.unlink(sourcePath)

    log.debug('task', 'Dequeued task', { id: task.id, action: task.action })
    return task
  } catch (err) {
    if (isNotFoundError(err)) return null // Race condition — another worker got it
    throw err
  }
}

/**
 * Mark a task as completed. Moves from processing/ to completed/.
 */
export async function completeTask(
  taskDir: string,
  taskId: string,
  result: Record<string, unknown>,
): Promise<void> {
  const processingPath = path.join(taskDir, 'processing', `${taskId}.json`)
  const completedDir = path.join(taskDir, 'completed')
  const completedPath = path.join(completedDir, `${taskId}.json`)

  let task: WorkerTask
  try {
    const content = await fs.readFile(processingPath, 'utf-8')
    const parsed = parseTaskJson(content)
    if (!parsed) {
      log.debug('task', 'Corrupt task file in processing, removing', { id: taskId })
      await fs.unlink(processingPath).catch(() => {})
      return
    }
    task = parsed
  } catch (err) {
    if (isNotFoundError(err)) return // Already moved
    throw err
  }

  task.status = 'completed'
  task.completedAt = new Date().toISOString()
  task.result = result

  await fs.mkdir(completedDir, { recursive: true })
  await fs.writeFile(completedPath, JSON.stringify(task, null, 2), 'utf-8')
  await fs.unlink(processingPath).catch(() => {})

  log.debug('task', 'Completed task', { id: taskId })
}

/**
 * Mark a task as failed. Moves from processing/ to failed/.
 */
export async function failTask(taskDir: string, taskId: string, error: string): Promise<void> {
  const processingPath = path.join(taskDir, 'processing', `${taskId}.json`)
  const failedDir = path.join(taskDir, 'failed')
  const failedPath = path.join(failedDir, `${taskId}.json`)

  let task: WorkerTask
  try {
    const content = await fs.readFile(processingPath, 'utf-8')
    const parsed = parseTaskJson(content)
    if (!parsed) {
      log.debug('task', 'Corrupt task file in processing, removing', { id: taskId })
      await fs.unlink(processingPath).catch(() => {})
      return
    }
    task = parsed
  } catch (err) {
    if (isNotFoundError(err)) return // Already moved
    throw err
  }

  task.status = 'failed'
  task.completedAt = new Date().toISOString()
  task.error = error

  await fs.mkdir(failedDir, { recursive: true })
  await fs.writeFile(failedPath, JSON.stringify(task, null, 2), 'utf-8')
  await fs.unlink(processingPath).catch(() => {})

  log.debug('task', 'Failed task', { id: taskId, error })
}

/**
 * Retry a task with exponential backoff. Moves from processing/ back to pending/.
 * Increments retryCount and sets retryAfter timestamp.
 */
export async function retryTask(taskDir: string, taskId: string, error: string): Promise<void> {
  const processingPath = path.join(taskDir, 'processing', `${taskId}.json`)
  const pendingDir = path.join(taskDir, 'pending')
  const pendingPath = path.join(pendingDir, `${taskId}.json`)

  let task: WorkerTask
  try {
    const content = await fs.readFile(processingPath, 'utf-8')
    const parsed = parseTaskJson(content)
    if (!parsed) {
      log.debug('task', 'Corrupt task file in processing, removing', { id: taskId })
      await fs.unlink(processingPath).catch(() => {})
      return
    }
    task = parsed
  } catch (err) {
    if (isNotFoundError(err)) return
    throw err
  }

  const retryCount = (task.retryCount ?? 0) + 1
  const backoffMs = Math.min(5000 * Math.pow(2, retryCount - 1), 60_000) // 5s, 10s, 20s, cap at 60s

  task.status = 'pending'
  task.retryCount = retryCount
  task.retryAfter = new Date(Date.now() + backoffMs).toISOString()
  task.error = error

  await fs.mkdir(pendingDir, { recursive: true })
  await fs.writeFile(pendingPath, JSON.stringify(task, null, 2), 'utf-8')
  await fs.unlink(processingPath).catch(() => {})

  log.debug('task', 'Retrying task', { id: taskId, retryCount, backoffMs })
}

/**
 * Recover orphaned tasks stuck in processing/.
 * Moves tasks older than maxAgeMs back to pending/ for retry.
 * Should be called on worker startup to handle crash recovery.
 *
 * Skips tasks that already exist in completed/ or failed/ (crash between
 * writing the result and unlinking the processing copy).
 */
export async function recoverOrphanedTasks(
  taskDir: string,
  maxAgeMs = 5 * 60_000,
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
          await moveToCorrupt(taskDir, processingDir, fileName, 'Invalid JSON during recovery')
          continue
        }

        // Dedup: if task already completed or failed, just clean up the orphan
        if (await taskExistsIn(taskDir, task.id, ['completed', 'failed'])) {
          await fs.unlink(filePath).catch(() => {})
          log.debug('task', 'Cleaned up orphaned task (already finished)', { id: task.id })
          continue
        }

        task.status = 'pending'

        await fs.mkdir(pendingDir, { recursive: true })
        await fs.writeFile(path.join(pendingDir, fileName), JSON.stringify(task, null, 2), 'utf-8')
        await fs.unlink(filePath)

        log.debug('task', 'Recovered orphaned task', { id: task.id, action: task.action })
        recovered++
      }
    } catch (err) {
      if (isNotFoundError(err)) continue
      log.debug('task', 'Failed to recover task', { fileName })
    }
  }

  return recovered
}

/**
 * Get the result of a specific task (for status polling).
 * Checks completed/ and failed/ directories.
 */
export async function getTaskResult(taskDir: string, taskId: string): Promise<WorkerTask | null> {
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
 * Clean up old task files from completed/ and failed/ directories.
 * Deletes files older than maxAgeMs (default: 30 days).
 */
export async function cleanupOldTasks(
  taskDir: string,
  maxAgeMs = 30 * 24 * 60 * 60_000,
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
    log.debug('task', 'Cleaned up old tasks', { cleaned })
  }
  return cleaned
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Parse a JSON string into a WorkerTask, returning null if invalid.
 */
function parseTaskJson(content: string): WorkerTask | null {
  try {
    const parsed = JSON.parse(content) as WorkerTask
    // Minimal validation: must have id and action
    if (typeof parsed.id !== 'string' || typeof parsed.action !== 'string') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/**
 * Check if a task file exists in any of the specified subdirectories.
 */
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

/**
 * Move a corrupt task file to the corrupt/ subdirectory for inspection.
 */
async function moveToCorrupt(
  taskDir: string,
  sourceDir: string,
  fileName: string,
  reason: string,
): Promise<void> {
  const corruptDir = path.join(taskDir, 'corrupt')
  try {
    await fs.mkdir(corruptDir, { recursive: true })
    await fs.rename(path.join(sourceDir, fileName), path.join(corruptDir, fileName))
    log.debug('task', 'Moved corrupt task file', { fileName, reason })
  } catch {
    // Best effort — if we can't move it, try to delete it
    await fs.unlink(path.join(sourceDir, fileName)).catch(() => {})
  }
}
