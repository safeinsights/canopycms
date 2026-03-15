/**
 * CanopyCMS task queue — re-exports from the generic task-queue module
 * with CMS-specific action types and a WorkerTask alias.
 */

import { createDebugLogger } from '../utils/debug'
import type { Task, TaskQueueLogger } from '../task-queue'

// ============================================================================
// CMS-specific types
// ============================================================================

/**
 * Actions the EC2 worker can execute on behalf of Lambda.
 */
export type TaskAction =
  | 'push-and-create-pr'
  | 'push-and-update-pr'
  | 'push-and-create-or-update-pr'
  | 'convert-to-draft'
  | 'close-pr'
  | 'delete-remote-branch'
  | 'push-branch'

/** A task with a CMS-specific action. */
export type WorkerTask = Task & { action: TaskAction }

// ============================================================================
// Shared logger instance for CMS task queue operations
// ============================================================================

const debugLogger = createDebugLogger({ prefix: 'TaskQueue' })

export const cmsTaskQueueLogger: TaskQueueLogger = {
  debug(message: string, data?: Record<string, unknown>) {
    debugLogger.debug('task', message, data)
  },
}

// ============================================================================
// Re-exports from generic task-queue module
// ============================================================================

export {
  enqueueTask,
  dequeueTask,
  completeTask,
  failTask,
  retryTask,
  recoverOrphanedTasks,
  cleanupOldTasks,
  getTask,
  getTask as getTaskResult, // backward-compatible alias
  listTasks,
  getQueueStats,
} from '../task-queue'

export type { Task, TaskStatus, QueueStats, TaskQueueLogger } from '../task-queue'
