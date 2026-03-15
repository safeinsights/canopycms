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
}

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

  // Read all pending tasks and sort by createdAt for FIFO ordering
  const tasks: { fileName: string; task: WorkerTask }[] = []
  for (const fileName of jsonFiles) {
    try {
      const content = await fs.readFile(path.join(pendingDir, fileName), 'utf-8')
      tasks.push({ fileName, task: JSON.parse(content) as WorkerTask })
    } catch (err) {
      if (isNotFoundError(err)) continue // Race condition — another worker got it
      throw err
    }
  }
  if (tasks.length === 0) return null

  tasks.sort((a, b) => a.task.createdAt.localeCompare(b.task.createdAt))
  const { fileName, task } = tasks[0]

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

  const content = await fs.readFile(processingPath, 'utf-8')
  const task = JSON.parse(content) as WorkerTask
  task.status = 'completed'
  task.completedAt = new Date().toISOString()
  task.result = result

  await fs.mkdir(completedDir, { recursive: true })
  await fs.writeFile(completedPath, JSON.stringify(task, null, 2), 'utf-8')
  await fs.unlink(processingPath)

  log.debug('task', 'Completed task', { id: taskId })
}

/**
 * Mark a task as failed. Moves from processing/ to failed/.
 */
export async function failTask(taskDir: string, taskId: string, error: string): Promise<void> {
  const processingPath = path.join(taskDir, 'processing', `${taskId}.json`)
  const failedDir = path.join(taskDir, 'failed')
  const failedPath = path.join(failedDir, `${taskId}.json`)

  const content = await fs.readFile(processingPath, 'utf-8')
  const task = JSON.parse(content) as WorkerTask
  task.status = 'failed'
  task.completedAt = new Date().toISOString()
  task.error = error

  await fs.mkdir(failedDir, { recursive: true })
  await fs.writeFile(failedPath, JSON.stringify(task, null, 2), 'utf-8')
  await fs.unlink(processingPath)

  log.debug('task', 'Failed task', { id: taskId, error })
}

/**
 * Recover orphaned tasks stuck in processing/.
 * Moves tasks older than maxAgeMs back to pending/ for retry.
 * Should be called on worker startup to handle crash recovery.
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
      if (now - stat.mtimeMs > maxAgeMs) {
        const content = await fs.readFile(filePath, 'utf-8')
        const task = JSON.parse(content) as WorkerTask
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
      return JSON.parse(content) as WorkerTask
    } catch {
      continue
    }
  }
  return null
}
