/**
 * Admin observability endpoints: task queue stats/listing and worker
 * liveness (PR-A1), plus task recovery actions — retry a failed task or
 * delete a stuck/corrupt task file (PR-A2) — for an admin-only dashboard.
 * Branch-health scan + purge/repair actions (PR-A3) live in
 * admin-branch-health.ts and are merged into ADMIN_ROUTES below.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { Task, QueueStats, CorruptTaskFile } from '../worker/task-queue'
import {
  getQueueStats,
  listTasks,
  listCorruptTaskFiles,
  requeueFailedTask,
} from '../worker/task-queue'
import { getTaskQueueDir } from '../worker/task-queue-config'
import { WORKER_STATUS_FILE } from '../worker/worker-status'
import type { WorkerStatusReport } from '../types'
import type { OperatingMode } from '../operating-mode'
import { defineEndpoint } from './route-builder'
import { getErrorMessage, isNotFoundError } from '../utils/error'
import { ADMIN_BRANCH_HEALTH_ROUTES } from './admin-branch-health'
// generate-client.ts resolves a route's response/body type module purely
// from its `namespace` field (see typeNameToModule/namespaceToModule in
// scripts/generate-client.ts) -- it has no way to know these four types
// actually live in admin-branch-health.ts, so client.ts's generated import
// expects them here. Re-export rather than teaching the generator a second
// file per namespace.
export type {
  BranchHealthResponse,
  PurgeBranchDirResponse,
  RepairBranchDirResponse,
  RepairContentDuplicatesResponse,
} from './admin-branch-health'

// ============================================================================
// Worker lock liveness
// ============================================================================

/**
 * 60_000 = DEFAULT_LOCK_STALE_MS in worker/cms-worker.ts, hardcoded here
 * rather than imported/threaded through config: an adopter overriding
 * `lockStaleMs` on their worker will skew this classification (documented
 * limitation — the observability endpoint doesn't know the worker's actual
 * config). +90_000 absorbs the EFS/NFS attribute-cache staleness window: a
 * freshly-refreshed heartbeat can still appear up to ~60s old to a reader on
 * a different host, since NFS clients cache file attributes.
 */
const LIVENESS_THRESHOLD_MS = 60_000 + 90_000

const DEFAULT_ADMIN_TASKS_LIMIT = 50
const MAX_ADMIN_TASKS_LIMIT = 200

export type WorkerLivenessState = 'alive' | 'stale' | 'absent'

export interface WorkerLiveness {
  /**
   * 'absent' — the lock dir is removed on clean release, so this also covers
   * "never started". 'alive' — heartbeat fresher than the threshold. 'stale'
   * — heartbeat older than the threshold (the holder likely crashed).
   */
  state: WorkerLivenessState
  lockMtime?: string
  lockAgeMs?: number
}

/** Classify worker liveness from the `.worker-lock` directory's mtime. */
async function classifyWorkerLiveness(taskDir: string): Promise<WorkerLiveness> {
  const lockPath = path.join(taskDir, '.worker-lock')
  let stat
  try {
    stat = await fs.stat(lockPath)
  } catch (err) {
    if (isNotFoundError(err)) return { state: 'absent' }
    throw err
  }

  // Clamped like getOldestPendingAgeMs below: filesystem mtime precision/
  // rounding (observed on APFS) can put mtimeMs a fraction of a millisecond
  // ahead of a Date.now() sampled immediately afterward, which would
  // otherwise report a nonsensical negative age.
  const lockAgeMs = Math.max(0, Date.now() - stat.mtimeMs)
  return {
    state: lockAgeMs < LIVENESS_THRESHOLD_MS ? 'alive' : 'stale',
    lockMtime: stat.mtime.toISOString(),
    lockAgeMs,
  }
}

/** Read + parse worker-status.json (written by the worker daemon, PR-W1). */
async function readWorkerStatus(
  taskDir: string,
): Promise<{ workerStatus: WorkerStatusReport | null; statusReadError?: string }> {
  const statusPath = path.join(taskDir, WORKER_STATUS_FILE)
  let content: string
  try {
    content = await fs.readFile(statusPath, 'utf-8')
  } catch (err) {
    if (isNotFoundError(err)) return { workerStatus: null }
    return { workerStatus: null, statusReadError: getErrorMessage(err) }
  }

  try {
    // Trust boundary: this file is written only by the CMS worker daemon
    // (PR-W1), never derived from request input — cast rather than
    // runtime-validate every field.
    const parsed = JSON.parse(content) as WorkerStatusReport
    return { workerStatus: parsed }
  } catch (err) {
    return { workerStatus: null, statusReadError: getErrorMessage(err) }
  }
}

/** Age (ms) of the oldest file in pending/, or undefined if empty/missing. */
async function getOldestPendingAgeMs(taskDir: string): Promise<number | undefined> {
  const pendingDir = path.join(taskDir, 'pending')
  let files: string[]
  try {
    files = await fs.readdir(pendingDir)
  } catch (err) {
    if (isNotFoundError(err)) return undefined
    throw err
  }

  let oldestMtimeMs: number | undefined
  for (const fileName of files.filter((f) => f.endsWith('.json'))) {
    try {
      const stat = await fs.stat(path.join(pendingDir, fileName))
      if (oldestMtimeMs === undefined || stat.mtimeMs < oldestMtimeMs) {
        oldestMtimeMs = stat.mtimeMs
      }
    } catch (err) {
      if (isNotFoundError(err)) continue
      throw err
    }
  }

  return oldestMtimeMs === undefined ? undefined : Math.max(0, Date.now() - oldestMtimeMs)
}

// ============================================================================
// Response types
// ============================================================================

export interface AdminStatusData {
  generatedAt: string
  mode: OperatingMode
  queue: QueueStats & { oldestPendingAgeMs?: number }
  worker: WorkerLiveness
  workerStatus: WorkerStatusReport | null
  statusReadError?: string
}

/** Response type for GET /admin/status */
export type AdminStatusResponse = ApiResponse<AdminStatusData>

export interface AdminTasksData {
  tasks?: Task[]
  corruptFiles?: CorruptTaskFile[]
}

/** Response type for GET /admin/tasks/:status */
export type AdminTasksResponse = ApiResponse<AdminTasksData>

export interface AdminRetryTaskData {
  newTaskId: string
}

/** Response type for POST /admin/tasks/:taskId/retry */
export type AdminRetryTaskResponse = ApiResponse<AdminRetryTaskData>

export interface AdminDeleteTaskData {
  deleted: true
}

/** Response type for DELETE /admin/tasks/:status/:fileName */
export type AdminDeleteTaskResponse = ApiResponse<AdminDeleteTaskData>

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

const adminTaskStatusSchema = z.enum(['pending', 'processing', 'completed', 'failed', 'corrupt'])

const listAdminTasksParamsSchema = z.object({
  status: adminTaskStatusSchema,
  // GET query params arrive as strings — coerce instead of rejecting them
  // (consistent with api/entries.ts's listEntriesParamsSchema).
  limit: z.coerce.number().int().min(1).max(MAX_ADMIN_TASKS_LIMIT).optional(),
})
export type ListAdminTasksParams = z.infer<typeof listAdminTasksParamsSchema>

// Task ids are crypto.randomUUID() output — keep the regex conservative (no
// dots/slashes) rather than trying to validate exact UUID shape.
const retryTaskParamsSchema = z.object({
  taskId: z.string().regex(/^[A-Za-z0-9-]{1,80}$/),
})
export type RetryTaskParams = z.infer<typeof retryTaskParamsSchema>

// processing/ and completed/ are deliberately excluded: processing/ is
// worker-owned (deleting there races completeTask's read-then-unlink), and
// completed/ is retained history, not a recovery target.
const deletableTaskStatusSchema = z.enum(['pending', 'failed', 'corrupt'])

const deleteTaskParamsSchema = z.object({
  status: deletableTaskStatusSchema,
  fileName: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,120}\.json$/)
    .refine((v) => !v.includes('..'), { message: 'fileName must not contain ..' }),
})
export type DeleteTaskParams = z.infer<typeof deleteTaskParamsSchema>

// ============================================================================
// Handlers
// ============================================================================

const getAdminStatusHandler = async (
  _gc: Record<string, never>,
  ctx: ApiContext,
  _req: ApiRequest,
): Promise<AdminStatusResponse> => {
  const taskDir = getTaskQueueDir(ctx.services.config)

  try {
    const [queueStats, oldestPendingAgeMs, worker, { workerStatus, statusReadError }] =
      await Promise.all([
        getQueueStats(taskDir),
        getOldestPendingAgeMs(taskDir),
        classifyWorkerLiveness(taskDir),
        readWorkerStatus(taskDir),
      ])

    return {
      ok: true,
      status: 200,
      data: {
        generatedAt: new Date().toISOString(),
        mode: ctx.services.config.mode,
        queue: {
          ...queueStats,
          ...(oldestPendingAgeMs !== undefined ? { oldestPendingAgeMs } : {}),
        },
        worker,
        workerStatus,
        ...(statusReadError ? { statusReadError } : {}),
      },
    }
  } catch (err) {
    return { ok: false, status: 500, error: getErrorMessage(err) }
  }
}

const listAdminTasksHandler = async (
  _gc: Record<string, never>,
  ctx: ApiContext,
  _req: ApiRequest,
  params: ListAdminTasksParams,
): Promise<AdminTasksResponse> => {
  const taskDir = getTaskQueueDir(ctx.services.config)
  const limit = params.limit ?? DEFAULT_ADMIN_TASKS_LIMIT

  try {
    if (params.status === 'corrupt') {
      return {
        ok: true,
        status: 200,
        data: { corruptFiles: await listCorruptTaskFiles(taskDir, limit) },
      }
    }

    return {
      ok: true,
      status: 200,
      data: { tasks: await listTasks(taskDir, params.status, limit) },
    }
  } catch (err) {
    return { ok: false, status: 500, error: getErrorMessage(err) }
  }
}

/**
 * Requeue a permanently-failed task as a brand-new pending task (see
 * `requeueFailedTask` for why the ID must be fresh, not reused).
 *
 * Accepted races (surfaced in the admin UI's confirm modal): retrying may
 * duplicate work if two admins race each other on the same failed task —
 * task actions are idempotent-or-benign by design, so a duplicate run is
 * expected to be harmless rather than prevented.
 */
const retryTaskHandler = async (
  _gc: Record<string, never>,
  ctx: ApiContext,
  _req: ApiRequest,
  params: RetryTaskParams,
): Promise<AdminRetryTaskResponse> => {
  const taskDir = getTaskQueueDir(ctx.services.config)

  try {
    const result = await requeueFailedTask(taskDir, params.taskId)
    if ('error' in result) {
      if (result.error === 'not-found') {
        return { ok: false, status: 404, error: 'Task not found in failed/' }
      }
      return {
        ok: false,
        status: 409,
        error: 'Failed task file is unparseable; delete it instead of retrying',
      }
    }
    return { ok: true, status: 200, data: { newTaskId: result.newTaskId } }
  } catch (err) {
    return { ok: false, status: 500, error: getErrorMessage(err) }
  }
}

/**
 * Delete a task file from pending/, failed/, or corrupt/. processing/ and
 * completed/ are not reachable here (see `deletableTaskStatusSchema`).
 *
 * Accepted races (surfaced in the admin UI's confirm modal): deleting from
 * pending/ does not guarantee the task never runs — the worker may have
 * already dequeued it, and if this unlink lands mid-dequeue (after the
 * worker's processing/ copy is written but before it unlinks the pending
 * source) the pending file is simply gone and the processing/ copy proceeds
 * normally; if instead the unlink races a copy that gets orphaned, that
 * orphan resurrects as a fresh pending task at the next worker restart via
 * `recoverOrphanedTasks`. Task actions are idempotent-or-benign by design,
 * so a task that ends up running anyway is not a correctness problem.
 */
const deleteTaskHandler = async (
  _gc: Record<string, never>,
  ctx: ApiContext,
  _req: ApiRequest,
  params: DeleteTaskParams,
): Promise<AdminDeleteTaskResponse> => {
  const taskDir = getTaskQueueDir(ctx.services.config)
  const dir = path.join(taskDir, params.status)
  const resolvedDir = path.resolve(dir)
  const filePath = path.resolve(dir, params.fileName)
  const dirWithSep = resolvedDir.endsWith(path.sep) ? resolvedDir : resolvedDir + path.sep

  // Belt-and-suspenders on top of the regex: guards against the resolved
  // path escaping the status directory (matches LocalAssetStore.resolveKey's
  // pattern in assets/store-local.ts).
  if (!filePath.startsWith(dirWithSep)) {
    return { ok: false, status: 400, error: 'Invalid task file name' }
  }

  try {
    await fs.unlink(filePath)
    return { ok: true, status: 200, data: { deleted: true } }
  } catch (err) {
    if (isNotFoundError(err)) {
      return { ok: false, status: 404, error: 'Task file not found' }
    }
    return { ok: false, status: 500, error: getErrorMessage(err) }
  }
}

// ============================================================================
// Route Definitions with defineEndpoint
// ============================================================================

/**
 * Task queue stats + worker liveness snapshot
 * GET /admin/status
 */
const getAdminStatus = defineEndpoint({
  namespace: 'admin',
  name: 'status',
  method: 'GET',
  path: '/admin/status',
  responseType: 'AdminStatusResponse',
  response: {} as AdminStatusResponse,
  defaultMockData: {
    generatedAt: '2024-01-01T00:00:00.000Z',
    mode: 'prod',
    queue: { pending: 0, processing: 0, completed: 0, failed: 0, corrupt: 0 },
    worker: { state: 'absent' },
    workerStatus: null,
  },
  guards: ['admin'] as const,
  handler: getAdminStatusHandler,
})

/**
 * List task files for a given status (or quarantined corrupt/ files)
 * GET /admin/tasks/:status
 */
const listAdminTasks = defineEndpoint({
  namespace: 'admin',
  name: 'listTasks',
  method: 'GET',
  path: '/admin/tasks/:status',
  params: listAdminTasksParamsSchema,
  responseType: 'AdminTasksResponse',
  response: {} as AdminTasksResponse,
  defaultMockData: { tasks: [] },
  guards: ['admin'] as const,
  handler: listAdminTasksHandler,
})

/**
 * Requeue a failed task as a fresh pending task
 * POST /admin/tasks/:taskId/retry
 */
const retryTask = defineEndpoint({
  namespace: 'admin',
  name: 'retryTask',
  method: 'POST',
  path: '/admin/tasks/:taskId/retry',
  params: retryTaskParamsSchema,
  responseType: 'AdminRetryTaskResponse',
  response: {} as AdminRetryTaskResponse,
  defaultMockData: { newTaskId: '00000000-0000-0000-0000-000000000000' },
  guards: ['admin'] as const,
  handler: retryTaskHandler,
})

/**
 * Delete a task file from pending/, failed/, or corrupt/
 * DELETE /admin/tasks/:status/:fileName
 */
const deleteTask = defineEndpoint({
  namespace: 'admin',
  name: 'deleteTask',
  method: 'DELETE',
  path: '/admin/tasks/:status/:fileName',
  params: deleteTaskParamsSchema,
  responseType: 'AdminDeleteTaskResponse',
  response: {} as AdminDeleteTaskResponse,
  defaultMockData: { deleted: true },
  guards: ['admin'] as const,
  handler: deleteTaskHandler,
})

/**
 * Exported routes for router registration.
 *
 * Branch-health scan + purge/repair (PR-A3) live in admin-branch-health.ts
 * (kept out of this file to stay under its size budget) and are merged in
 * here so the router (http/router.ts) and generate-client.ts keep a single
 * `ADMIN_ROUTES` import.
 */
export const ADMIN_ROUTES = {
  status: getAdminStatus,
  listTasks: listAdminTasks,
  retryTask,
  deleteTask,
  ...ADMIN_BRANCH_HEALTH_ROUTES,
} as const
