/**
 * A task in the file-based queue.
 *
 * The `action` field is an arbitrary string — the queue does not interpret it.
 * Consumers define their own action vocabularies.
 */
export interface Task {
  id: string
  action: string
  payload: Record<string, unknown>
  status: TaskStatus
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

export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed'

/** Summary counts for each task status. */
export interface QueueStats {
  pending: number
  processing: number
  completed: number
  failed: number
  corrupt: number
}

/**
 * Optional logger interface.
 * Pass your own logger to `createTaskQueue()`, or omit for silent operation.
 */
export interface TaskQueueLogger {
  debug(message: string, data?: Record<string, unknown>): void
}

/**
 * Metadata for a file quarantined in corrupt/ (unparseable JSON, or JSON
 * missing required Task fields — see `parseTaskJson`). `listTasks()` silently
 * drops these; `listCorruptTaskFiles()` surfaces them for diagnosis.
 */
export interface CorruptTaskFile {
  fileName: string
  size: number
  mtime: string // ISO
  rawSnippet: string // first ~500 bytes for diagnosis
}
