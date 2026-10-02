/**
 * The CMS queue contract: the generic queue in ./task-queue plus the CMS
 * action vocabulary, a WorkerTask alias and the debug logger. Published as
 * `canopycms/worker/task-queue`.
 */

import { createDebugLogger } from '../utils/debug'
import type { Task, TaskQueueLogger } from './types'

/** Actions the EC2 worker can execute on behalf of Lambda. */
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

const debugLogger = createDebugLogger({ prefix: 'TaskQueue' })

export const cmsTaskQueueLogger: TaskQueueLogger = {
  debug(message: string, data?: Record<string, unknown>) {
    debugLogger.debug('task', message, data)
  },
}

export {
  enqueueTask,
  dequeueTask,
  completeTask,
  failTask,
  retryTask,
  requeueFailedTask,
  recoverOrphanedTasks,
  cleanupOldTasks,
  getTask,
  listTasks,
  getQueueStats,
  listCorruptTaskFiles,
} from './task-queue'

export type { Task, TaskStatus, QueueStats, TaskQueueLogger, CorruptTaskFile } from './types'
