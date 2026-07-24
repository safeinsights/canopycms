/**
 * Admin observability endpoints: task queue stats/listing and worker
 * liveness, for an admin-only dashboard. Read-only (PR-A1) — task recovery
 * actions (retry/delete) land in a later PR.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import type { ApiContext, ApiRequest, ApiResponse } from './types'
import type { Task, QueueStats, CorruptTaskFile } from '../worker/task-queue'
import { getQueueStats, listTasks, listCorruptTaskFiles } from '../worker/task-queue'
import { getTaskQueueDir } from '../worker/task-queue-config'
import type { WorkerStatusReport } from '../types'
import type { OperatingMode } from '../operating-mode'
import { defineEndpoint } from './route-builder'
import { getErrorMessage, isNotFoundError } from '../utils/error'

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
  const statusPath = path.join(taskDir, 'worker-status.json')
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
 * Exported routes for router registration
 */
export const ADMIN_ROUTES = {
  status: getAdminStatus,
  listTasks: listAdminTasks,
} as const
