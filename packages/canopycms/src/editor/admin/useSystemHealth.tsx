'use client'

/**
 * useSystemHealth - Data + actions for the admin System Health panel (PR-U1).
 *
 * Mirrors useGroupManager's shape: loads on open, exposes typed action
 * helpers that each notify then refresh(). Unlike useGroupManager, this also
 * polls every 30s while the panel stays open (cleared on close/unmount) --
 * queue depth and worker liveness go stale quickly, and the panel has no
 * other way to catch a worker coming back up or a task finishing.
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

const POLL_INTERVAL_MS = 30_000

/**
 * Crash-loop rider window: a worker that fatally exits and restarts
 * repeatedly can flap between 'absent' and 'alive' liveness and never sit
 * still long enough to read 'stale' -- surfacing a recent lastFatalError
 * regardless of liveness state is the only way the panel catches that.
 */
const CRASH_LOOP_WINDOW_MS = 30 * 60_000

export type AdminTaskStatus = ListAdminTasksParams['status']
export type DeletableTaskStatus = DeleteTaskParams['status']

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
   * the last fetch. Computed at fetch time (not in the component's render)
   * so the panel never calls Date.now() during render -- see the
   * react-hooks/purity rule this sidesteps.
   */
  isRecentFatalError: boolean
  tasks: AdminTasksData | null
  tasksLoading: boolean
  taskStatus: AdminTaskStatus
  /** Updates the selected Tasks-tab status AND refetches tasks for it. */
  setTaskStatus: (status: AdminTaskStatus) => void
  branchHealth: BranchHealthData | null
  branchHealthLoading: boolean
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
  const [error, setError] = useState<string | null>(null)

  // refresh() has no status argument, so it needs the CURRENT taskStatus
  // without taking a dependency on it (that would tear down/rebuild the
  // polling interval below every time the Tasks tab's segmented control
  // changes). A ref sidesteps the stale-closure problem cleanly.
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
      const result = await apiClient.admin.branchHealth()
      if (!result.ok) throw new Error(result.error || 'Failed to load branch health')
      setBranchHealth(result.data ?? null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load branch health')
    } finally {
      setBranchHealthLoading(false)
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
    error,
    refresh,
    retryTask,
    deleteTask,
    purgeDir,
    repairDir,
    markMerged,
  }
}
