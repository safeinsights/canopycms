'use client'

/**
 * useSystemHealth - Data + actions for the admin System Health panel.
 *
 * Mirrors useGroupManager's shape (load on open, typed actions that notify
 * then refresh()), but also polls every 30s while open (cleared on
 * close/unmount) since queue depth and worker liveness go stale quickly and
 * the panel has no other way to catch a worker recovering or a task finishing.
 *
 * The duplicate-ID scan is the exception: it reads every healthy branch's whole
 * content tree, so it runs on open, on request, and after a duplicate repair,
 * never on the poll.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { notifications } from '@mantine/notifications'
import { useApiClient } from '../context'
import type {
  AdminStatusData,
  AdminTasksData,
  ListAdminTasksParams,
  DeleteTaskParams,
} from '../../api/admin'
import type { BranchHealthData } from '../../api/admin-branch-health'
import type { DuplicateIdScan } from '../../branch-health'

const POLL_INTERVAL_MS = 30_000

/**
 * Crash-loop rider window: a worker that fatally exits and restarts
 * repeatedly can flap between 'absent' and 'alive' and never sit still long
 * enough to read 'stale' — surfacing a recent lastFatalError regardless of
 * liveness state is the only way the panel catches that.
 */
const CRASH_LOOP_WINDOW_MS = 30 * 60_000

export type AdminTaskStatus = ListAdminTasksParams['status']
export type DeletableTaskStatus = DeleteTaskParams['status']

/** The last completed duplicate-ID scan (`GET /admin/branch-health?duplicates=1`). */
interface DuplicateIdScanResult {
  /** Healthy branches only, by dirName. A healthy row missing here was not scanned. */
  byDir: Record<string, DuplicateIdScan>
  /** The server's time budget ran out before every healthy branch was scanned. */
  truncated: boolean
  generatedAt: string
}

export interface UseSystemHealthOptions {
  /**
   * Whether the System Health panel is currently open. Data loads (and
   * polling starts) only while true -- mirrors useGroupManager's `isOpen`.
   */
  isOpen: boolean
}

export interface UseSystemHealthReturn {
  status: AdminStatusData | null
  statusLoading: boolean
  /**
   * True when workerStatus.lastFatalError exists and is < 30 min old, as of
   * the last fetch. Computed at fetch time, not in the component's render, so
   * the panel never calls Date.now() during render (react-hooks/purity).
   */
  isRecentFatalError: boolean
  tasks: AdminTasksData | null
  tasksLoading: boolean
  taskStatus: AdminTaskStatus
  /** Updates the selected Tasks-tab status AND refetches tasks for it. */
  setTaskStatus: (status: AdminTaskStatus) => void
  branchHealth: BranchHealthData | null
  branchHealthLoading: boolean
  /** Null until a scan completes, and after a scan request fails. */
  duplicateIdScan: DuplicateIdScanResult | null
  duplicateIdScanLoading: boolean
  duplicateIdScanError: string | null
  /** Runs the duplicate-ID scan. */
  checkDuplicateIds: () => Promise<void>
  /** Archives the branch's duplicate files, then re-runs the scan. */
  repairDuplicateIds: (dirName: string) => Promise<void>
  /** Last fetch error across status/tasks/branchHealth, if any. */
  error: string | null
  /** Refetches status, tasks (at the current taskStatus), and branchHealth. */
  refresh: () => Promise<void>
  retryTask: (taskId: string) => Promise<void>
  deleteTask: (status: DeletableTaskStatus, fileName: string) => Promise<void>
  purgeDir: (dirName: string) => Promise<void>
  repairDir: (dirName: string) => Promise<void>
  markMerged: (branchName: string) => Promise<void>
}

export function useSystemHealth(options: UseSystemHealthOptions): UseSystemHealthReturn {
  const apiClient = useApiClient()
  const [status, setStatus] = useState<AdminStatusData | null>(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [isRecentFatalError, setIsRecentFatalError] = useState(false)
  const [tasks, setTasks] = useState<AdminTasksData | null>(null)
  const [tasksLoading, setTasksLoading] = useState(false)
  const [taskStatus, setTaskStatusState] = useState<AdminTaskStatus>('failed')
  const [branchHealth, setBranchHealth] = useState<BranchHealthData | null>(null)
  const [branchHealthLoading, setBranchHealthLoading] = useState(false)
  const [duplicateIdScan, setDuplicateIdScan] = useState<DuplicateIdScanResult | null>(null)
  const [duplicateIdScanLoading, setDuplicateIdScanLoading] = useState(false)
  const [duplicateIdScanError, setDuplicateIdScanError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // refresh() has no status argument, so it needs the CURRENT taskStatus
  // without depending on it (that would tear down/rebuild the poll interval
  // below on every Tasks-tab status change) — a ref sidesteps the stale closure.
  const taskStatusRef = useRef(taskStatus)
  taskStatusRef.current = taskStatus

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true)
    try {
      const result = await apiClient.admin.status()
      if (!result.ok) throw new Error(result.error || 'Failed to load status')
      const data = result.data ?? null
      setStatus(data)
      // Date.now() belongs here (an async callback, evaluated at fetch time)
      // rather than in the component's render body.
      const fatalAt = data?.workerStatus?.lastFatalError?.at
      setIsRecentFatalError(
        !!fatalAt && Date.now() - new Date(fatalAt).getTime() < CRASH_LOOP_WINDOW_MS,
      )
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load status')
    } finally {
      setStatusLoading(false)
    }
  }, [apiClient])

  const fetchTasks = useCallback(
    async (forStatus: AdminTaskStatus) => {
      setTasksLoading(true)
      try {
        const result = await apiClient.admin.listTasks({ status: forStatus })
        if (!result.ok) throw new Error(result.error || 'Failed to load tasks')
        setTasks(result.data ?? null)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load tasks')
      } finally {
        setTasksLoading(false)
      }
    },
    [apiClient],
  )

  const fetchBranchHealth = useCallback(async () => {
    setBranchHealthLoading(true)
    try {
      const result = await apiClient.admin.branchHealth({})
      if (!result.ok) throw new Error(result.error || 'Failed to load branch health')
      setBranchHealth(result.data ?? null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load branch health')
    } finally {
      setBranchHealthLoading(false)
    }
  }, [apiClient])

  // Only the latest scan request may write state: a repair's re-scan can
  // overlap the on-open scan, and the older response would bring back
  // duplicates the repair just archived.
  const duplicateScanSeq = useRef(0)
  const checkDuplicateIds = useCallback(async () => {
    const seq = ++duplicateScanSeq.current
    setDuplicateIdScanLoading(true)
    try {
      const result = await apiClient.admin.branchHealth({ duplicates: '1' })
      if (seq !== duplicateScanSeq.current) return
      if (!result.ok || !result.data?.duplicateIdScan) {
        throw new Error(result.error || 'Failed to check for duplicate content IDs')
      }
      const byDir: Record<string, DuplicateIdScan> = {}
      for (const entry of result.data.entries) {
        if (entry.duplicateIdScan) byDir[entry.dirName] = entry.duplicateIdScan
      }
      setDuplicateIdScan({
        byDir,
        truncated: result.data.duplicateIdScan.truncated,
        generatedAt: result.data.generatedAt,
      })
      setDuplicateIdScanError(null)
    } catch (err) {
      if (seq !== duplicateScanSeq.current) return
      setDuplicateIdScan(null)
      setDuplicateIdScanError(
        err instanceof Error ? err.message : 'Failed to check for duplicate content IDs',
      )
    } finally {
      if (seq === duplicateScanSeq.current) setDuplicateIdScanLoading(false)
    }
  }, [apiClient])

  const refresh = useCallback(async () => {
    await Promise.all([fetchStatus(), fetchTasks(taskStatusRef.current), fetchBranchHealth()])
  }, [fetchStatus, fetchTasks, fetchBranchHealth])

  const setTaskStatus = useCallback(
    (next: AdminTaskStatus) => {
      setTaskStatusState(next)
      void fetchTasks(next)
    },
    [fetchTasks],
  )

  // Load on open, and poll every 30s while open. taskStatus deliberately
  // excluded from deps -- refresh() reads it via taskStatusRef, so switching
  // the Tasks tab's status doesn't tear down/restart the poll timer.
  useEffect(() => {
    if (!options.isOpen) return
    refresh()
    void checkDuplicateIds()
    const interval = setInterval(() => {
      refresh()
    }, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh is stable (useCallback); see comment above
  }, [options.isOpen])

  const retryTask = useCallback(
    async (taskId: string) => {
      try {
        const result = await apiClient.admin.retryTask({ taskId })
        if (!result.ok) throw new Error(result.error || 'Failed to retry task')
        notifications.show({
          message: `Task requeued as ${result.data?.newTaskId ?? 'a new task'}`,
          color: 'green',
        })
        await refresh()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to retry task'
        notifications.show({ message, color: 'red' })
      }
    },
    [apiClient, refresh],
  )

  const deleteTask = useCallback(
    async (status: DeletableTaskStatus, fileName: string) => {
      try {
        const result = await apiClient.admin.deleteTask({ status, fileName })
        if (!result.ok) throw new Error(result.error || 'Failed to delete task')
        notifications.show({ message: 'Task file deleted', color: 'green' })
        await refresh()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to delete task'
        notifications.show({ message, color: 'red' })
      }
    },
    [apiClient, refresh],
  )

  const purgeDir = useCallback(
    async (dirName: string) => {
      try {
        const result = await apiClient.admin.purgeBranchDir({ dirName })
        if (!result.ok) throw new Error(result.error || 'Failed to purge directory')
        notifications.show({
          message: `Directory moved to trash as ${result.data?.trashedAs ?? 'trash'}`,
          color: 'green',
        })
        await refresh()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to purge directory'
        notifications.show({ message, color: 'red' })
      }
    },
    [apiClient, refresh],
  )

  const repairDir = useCallback(
    async (dirName: string) => {
      try {
        const result = await apiClient.admin.repairBranchDir({ dirName })
        if (!result.ok) throw new Error(result.error || 'Failed to repair metadata')
        notifications.show({
          message: `Metadata repaired (corrupt file archived as ${result.data?.archivedAs ?? 'archive'})`,
          color: 'green',
        })
        await refresh()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to repair metadata'
        notifications.show({ message, color: 'red' })
      }
    },
    [apiClient, refresh],
  )

  const repairDuplicateIds = useCallback(
    async (dirName: string) => {
      try {
        const result = await apiClient.admin.repairContentDuplicates({ dirName })
        if (!result.ok) throw new Error(result.error || 'Failed to archive duplicate files')
        const archived = (result.data?.resolved ?? []).reduce((n, r) => n + r.archivedAs.length, 0)
        notifications.show({
          message: `Archived ${archived} duplicate file${archived === 1 ? '' : 's'}`,
          color: 'green',
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to archive duplicate files'
        notifications.show({ message, color: 'red' })
      }
      // Re-scan on failure too: a 409 or a partial repair leaves the branch in
      // a state the last scan no longer describes.
      await checkDuplicateIds()
    },
    [apiClient, checkDuplicateIds],
  )

  const markMerged = useCallback(
    async (branchName: string) => {
      try {
        const result = await apiClient.workflow.markMerged({ branch: branchName })
        if (!result.ok) throw new Error(result.error || 'Failed to mark branch as merged')
        notifications.show({ message: `Branch "${branchName}" marked as merged`, color: 'green' })
        await refresh()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to mark branch as merged'
        notifications.show({ message, color: 'red' })
      }
    },
    [apiClient, refresh],
  )

  return {
    status,
    statusLoading,
    isRecentFatalError,
    tasks,
    tasksLoading,
    taskStatus,
    setTaskStatus,
    branchHealth,
    branchHealthLoading,
    duplicateIdScan,
    duplicateIdScanLoading,
    duplicateIdScanError,
    checkDuplicateIds,
    repairDuplicateIds,
    error,
    refresh,
    retryTask,
    deleteTask,
    purgeDir,
    repairDir,
    markMerged,
  }
}
