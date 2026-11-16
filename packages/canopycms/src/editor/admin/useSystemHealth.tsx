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
import { useSWRConfig } from 'swr'
import { notifications } from '@mantine/notifications'
import { useApiClient } from '../context'
import type {
  AdminStatusData,
  AdminTasksData,
  ListAdminTasksParams,
  DeleteTaskParams,
} from '../../api/admin'
import type { BranchHealthData, RepairBranchDirResponse } from '../../api/admin-branch-health'
import { isNobody } from '../../system-users'
import { isExcludedFrom } from '../../authorization/helpers'
import type { BranchAccessControl } from '../../types'
import type { DuplicateIdScan } from '../../branch-health'
import { BRANCHES_KEY } from '../hooks/useBranchesData'
import { isGatewayFailure, isUnanswered, UnansweredError } from '../unanswered'

const POLL_INTERVAL_MS = 30_000

const EMPTY_DELETE = {
  deleted: [],
  skipped: { notMerged: [], unpublished: [] },
  failed: [],
  remaining: 0,
  warnings: [],
}

const countBranches = (count: number): string =>
  `${count} archived ${count === 1 ? 'branch' : 'branches'}`

type RepairedBranch = NonNullable<RepairBranchDirResponse['data']>

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

/** The people and groups `access` removed, who stay out, in a sentence; '' when there are none. */
function stayOutSentence(access: BranchAccessControl): string {
  const people = Object.keys(access.excluded ?? {}).length
  const groups = Object.keys(access.excludedGroups ?? {}).length
  if (people + groups === 0) return ''
  const removed = [
    people > 0 ? plural(people, 'person', 'people') : '',
    groups > 0 ? plural(groups, 'group', 'groups') : '',
  ]
    .filter(Boolean)
    .join(' and ')
  return ` The ${removed} removed from it ${people + groups === 1 ? 'stays' : 'stay'} out.`
}

/** Who can open a repaired branch now, and whether an admin has to act on it. */
function repairedAccess(repaired: RepairedBranch): { text: string; mustAct: boolean } {
  const { access, createdBy } = repaired.branch
  const stayOut = stayOutSentence(access)
  if (repaired.reset.access) {
    // No access-list change lifts a lockdown (authorization/branch-sharing.ts).
    if (access.managerOrAdminAllowed) {
      return {
        text: repaired.lockedByRepair
          ? `Access couldn't be read, so this branch is locked to admins and reviewers. Opening it again needs its branch.json edited by hand.${stayOut}`
          : `Access couldn't be read, but its lockdown could, so only admins and reviewers can open it. Lifting the lockdown needs its branch.json edited by hand.${stayOut}`,
        mustAct: true,
      }
    }
    if (repaired.restricted) {
      return {
        text: `Access couldn't be read, so only admins and reviewers can open it. Share it again from "Branches".${stayOut}`,
        mustAct: true,
      }
    }
    // Only the base branch and dev's active branch fall back to no list.
    return {
      text: `Access couldn't be read. This branch takes no access list, so anyone who can sign in can open this branch.${stayOut}`,
      mustAct: false,
    }
  }
  const who = access.managerOrAdminAllowed
    ? 'only admins and reviewers can open it'
    : repaired.restricted
      ? 'only the people listed can open it'
      : repaired.openToEveryone
        ? 'anyone who can sign in can open it'
        : isNobody(createdBy) || isExcludedFrom(access, createdBy)
          ? 'only admins and reviewers can open it'
          : 'only its creator, admins and reviewers can open it'
  return { text: `Kept its access: ${who}.${stayOut}`, mustAct: false }
}

/** What else a repair could not read and held back, each needing an admin; in sentences. */
function repairedHolds(repaired: RepairedBranch): string[] {
  const { reset, branch } = repaired
  const archived = branch.status === 'archived'
  return [
    reset.status === 'submitted'
      ? "Its status couldn't be read, so it is locked as submitted until it is withdrawn."
      : '',
    reset.createdBy !== undefined && !repaired.openToEveryone
      ? 'Its creator couldn\'t be read or was missing, so only an admin can share it again from "Branches".'
      : '',
    reset.unpublishedAtMerge
      ? "Its merge record couldn't be read, so only an admin can delete it."
      : '',
    reset.rewrittenOnGitHub !== undefined
      ? archived
        ? "Its record of GitHub's branch couldn't be read, so only an admin can delete it."
        : "Its record of GitHub's branch couldn't be read, so nothing is pushed to GitHub until a sync clears it: once GitHub has no branch of this name, or once this branch is published and GitHub's holds every commit CanopyCMS recorded."
      : '',
    reset.archivedAt !== undefined && archived
      ? "Its archive time couldn't be read, so deletion by age counts from this repair."
      : '',
  ].filter(Boolean)
}

/** The repaired branch's status, unless {@link repairedHolds} already says it. */
function statusSentence(repaired: RepairedBranch): string {
  if (repaired.reset.status === 'submitted') return ''
  switch (repaired.branch.status) {
    case 'archived':
      return 'It stays archived.'
    case 'submitted':
      return 'It stays submitted.'
    case 'approved':
      return 'It stays approved.'
    default:
      return 'Its status is editing.'
  }
}

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
  /** Deletes those of `branches` still past `olderThanDays`, then says what it could not. */
  deleteArchivedBranches: (olderThanDays: number, branches: string[]) => Promise<void>
  deletingArchivedBranches: boolean
  /** Stops listing a branch merged with an unfinished submit, a warning that doesn't come back. */
  dismissUnpublished: (dirName: string) => Promise<void>
}

export function useSystemHealth(options: UseSystemHealthOptions): UseSystemHealthReturn {
  const apiClient = useApiClient()
  const { mutate } = useSWRConfig()
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
  const [deletingArchivedBranches, setDeletingArchivedBranches] = useState(false)
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
        if (!result.ok || !result.data) throw new Error(result.error || 'Failed to repair metadata')
        const { text, mustAct } = repairedAccess(result.data)
        const holds = repairedHolds(result.data)
        const message = [
          text,
          ...holds,
          statusSentence(result.data),
          `The corrupt file is archived as ${result.data.archivedAs}.`,
          result.data.warning ?? '',
        ]
          .filter(Boolean)
          .join(' ')
        const needsAdmin = mustAct || holds.length > 0 || result.data.warning !== undefined
        notifications.show({
          title: 'Metadata repaired',
          message,
          ...(needsAdmin ? { color: 'yellow', autoClose: false } : { color: 'green' }),
        })
        await refresh()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to repair metadata'
        // A failed repair can leave the branch with another write's metadata the admin must check.
        notifications.show({ message, color: 'red', autoClose: false })
      }
    },
    [apiClient, refresh],
  )

  const dismissUnpublished = useCallback(
    async (dirName: string) => {
      try {
        const result = await apiClient.admin.dismissUnpublished({ dirName })
        if (!result.ok && result.status !== 409) {
          throw new Error(result.error || 'Failed to dismiss the warning')
        }
        if (!result.ok) notifications.show({ message: result.error, color: 'yellow' })
        await refresh()
        // The branch's own "Needs action" comes from the list.
        await mutate(BRANCHES_KEY)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to dismiss the warning'
        notifications.show({ message, color: 'red' })
      }
    },
    [apiClient, mutate, refresh],
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
        // Diagnosis keeps the full ref; the Branches table beside it shows the workspace directory.
        notifications.show({ message: `Branch "${branchName}" marked as merged`, color: 'green' })
        await refresh()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to mark branch as merged'
        notifications.show({ message, color: 'red' })
      }
    },
    [apiClient, refresh],
  )

  const deleteArchivedBranches = useCallback(
    async (olderThanDays: number, branches: string[]) => {
      setDeletingArchivedBranches(true)
      try {
        const result = await apiClient.admin.deleteArchivedBranches({ olderThanDays, branches })
        if (isGatewayFailure(result)) throw new UnansweredError()
        if (!result.ok) throw new Error(result.error || 'Failed to delete archived branches')
        const { deleted, skipped, failed, remaining, warnings } = result.data ?? EMPTY_DELETE
        const left = [
          failed.length > 0
            ? `${countBranches(failed.length)} not deleted: busy, or changed since listed`
            : '',
          remaining > 0 ? `${countBranches(remaining)} not reached, run this again` : '',
          skipped.notMerged.length > 0
            ? `${countBranches(skipped.notMerged.length)} kept: not merged`
            : '',
          skipped.unpublished.length > 0
            ? `${countBranches(skipped.unpublished.length)} kept: may hold unpublished changes`
            : '',
          ...warnings,
        ].filter(Boolean)
        const message = `Deleted ${countBranches(deleted.length)}`
        notifications.show(
          left.length > 0
            ? { message: `${message}. ${left.join('. ')}.`, color: 'yellow', autoClose: false }
            : { message, color: 'green' },
        )
        await mutate(BRANCHES_KEY)
        await refresh()
      } catch (err) {
        if (isUnanswered(err)) {
          notifications.show({
            message:
              'Deleting archived branches may have gone through even though the server didn\'t answer. Check the "Branches" tab.',
            color: 'yellow',
            autoClose: false,
          })
          await mutate(BRANCHES_KEY)
          await refresh()
          return
        }
        const message = err instanceof Error ? err.message : 'Failed to delete archived branches'
        notifications.show({ message, color: 'red', autoClose: false })
      } finally {
        setDeletingArchivedBranches(false)
      }
    },
    [apiClient, mutate, refresh],
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
    deleteArchivedBranches,
    deletingArchivedBranches,
    dismissUnpublished,
  }
}
