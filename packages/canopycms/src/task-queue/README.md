# task-queue

A file-based persistent task queue for Node.js. Tasks are JSON files organized in subdirectories by status. Designed for shared filesystems (EFS, NFS) where one process enqueues and another dequeues.

No external dependencies — only Node.js stdlib (`fs`, `path`, `crypto`).

## Directory layout

```
{taskDir}/
  pending/        tasks ready to be picked up
  processing/     tasks currently being executed
  completed/      tasks that finished successfully
  failed/         tasks that permanently failed (exhausted retries)
  corrupt/        unreadable files moved here for inspection
```

## Usage

```typescript
import {
  enqueueTask,
  dequeueTask,
  completeTask,
  failTask,
  retryTask,
  recoverOrphanedTasks,
  getTask,
  listTasks,
  getQueueStats,
} from 'canopycms/task-queue'

// Producer (e.g., Lambda, API handler)
const taskId = await enqueueTask('/mnt/efs/.tasks', {
  action: 'send-email',
  payload: { to: 'user@example.com', subject: 'Hello' },
})

// Consumer (e.g., worker daemon)
const task = await dequeueTask('/mnt/efs/.tasks')
if (task) {
  try {
    const result = await sendEmail(task.payload)
    await completeTask('/mnt/efs/.tasks', task.id, result)
  } catch (err) {
    // Retry with exponential backoff, or fail permanently
    if ((task.retryCount ?? 0) < (task.maxRetries ?? 3)) {
      await retryTask('/mnt/efs/.tasks', task.id, err.message)
    } else {
      await failTask('/mnt/efs/.tasks', task.id, err.message)
    }
  }
}
```

## API

### Core operations

| Function | Description |
|----------|-------------|
| `enqueueTask(taskDir, { action, payload, maxRetries? })` | Create a pending task. Returns the task ID. |
| `dequeueTask(taskDir)` | Get the oldest ready task, move it to processing. Returns `null` if empty. |
| `completeTask(taskDir, taskId, result)` | Mark a task as completed with a result object. |
| `failTask(taskDir, taskId, error)` | Mark a task as permanently failed. |
| `retryTask(taskDir, taskId, error)` | Move a task back to pending with exponential backoff. |

### Recovery & maintenance

| Function | Description |
|----------|-------------|
| `recoverOrphanedTasks(taskDir, maxAgeMs?)` | Move stale processing tasks back to pending. Call on startup. Default: 5 min. |
| `cleanupOldTasks(taskDir, maxAgeMs?)` | Delete old completed/failed tasks. Default: 30 days. |

### Query (for UIs, monitoring)

| Function | Description |
|----------|-------------|
| `getTask(taskDir, taskId)` | Find a task by ID in any status directory. |
| `listTasks(taskDir, status, limit?)` | List tasks in a status directory, sorted by createdAt. |
| `getQueueStats(taskDir)` | Count of tasks in each status: `{ pending, processing, completed, failed, corrupt }`. |

## Retry behavior

Tasks have `retryCount`, `maxRetries`, and `retryAfter` fields:

- `retryTask()` increments `retryCount` and sets `retryAfter` with exponential backoff
- Backoff schedule: 5s, 10s, 20s, 40s, 60s (capped)
- `dequeueTask()` skips tasks whose `retryAfter` is in the future
- After `maxRetries` exhausted, use `failTask()` to move to failed/

Default `maxRetries` is 3 (configurable per-task at enqueue time).

## Crash safety

The queue uses a write-then-unlink pattern for state transitions. If the process crashes between these operations, a task could exist in two directories. The queue handles this:

- **Dedup on dequeue**: Before executing a dequeued task, checks if it already exists in `completed/` or `failed/`. If so, cleans up the stale copy instead of re-executing.
- **Dedup on recovery**: `recoverOrphanedTasks()` checks the same before moving an orphaned task back to pending.
- **Corrupt file handling**: Malformed JSON files are moved to `corrupt/` instead of crashing the consumer.

## Logger

All functions accept an optional logger as the last argument:

```typescript
const logger = {
  debug(message: string, data?: Record<string, unknown>) {
    console.log(`[TaskQueue] ${message}`, data)
  }
}

await enqueueTask(taskDir, task, logger)
await dequeueTask(taskDir, logger)
```

Omit the logger for silent operation.

## Task shape

```typescript
interface Task {
  id: string                          // UUID, auto-generated
  action: string                      // arbitrary — the queue doesn't interpret it
  payload: Record<string, unknown>    // action-specific data
  status: 'pending' | 'processing' | 'completed' | 'failed'
  createdAt: string                   // ISO timestamp
  completedAt?: string                // set on complete/fail
  result?: Record<string, unknown>    // set on complete
  error?: string                      // set on fail/retry
  retryCount?: number                 // 0-based
  maxRetries?: number                 // default 3
  retryAfter?: string                 // ISO timestamp — skip until then
}
```

## CanopyCMS integration

Within CanopyCMS, the worker layer (`src/worker/`) wraps this module with:

- **`TaskAction` type** — a union of CMS-specific actions (`push-and-create-pr`, `close-pr`, etc.)
- **`WorkerTask` alias** — `Task & { action: TaskAction }`
- **`cmsTaskQueueLogger`** — wired to CanopyCMS's debug logger
- **`task-queue-config.ts`** — resolves the task directory from CanopyCMS operating mode config
