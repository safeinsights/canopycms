import { useEffect, useMemo, useState } from 'react'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { Text } from '@mantine/core'
import type { BranchState } from '../../types'
import type { BranchMode } from '../../paths'
import type { ApiResponse } from '../../api/types'
import type { FormValue } from '../FormRenderer'
import type { CommentThread } from '../../comment-store'

/**
 * Branch summary for display in BranchManager component.
 */
export interface BranchSummary {
  name: string
  status: string
  createdBy?: string
  updatedAt?: string
  access: {
    users: string[] | undefined
    groups: string[] | undefined
  }
  pullRequestUrl?: string
  pullRequestNumber?: number
  commentCount: number
}

export interface UseBranchManagerOptions {
  /**
   * Initial branch name.
   */
  initialBranch: string

  /**
   * Branch mode (local-simple, collaboration, etc.).
   */
  branchMode: BranchMode

  /**
   * Currently selected entry ID.
   */
  selectedId: string

  /**
   * Current draft values by entry ID.
   */
  drafts: Record<string, FormValue>

  /**
   * Loaded values by entry ID.
   */
  loadedValues: Record<string, FormValue>

  /**
   * Callback to set drafts.
   */
  setDrafts: (drafts: Record<string, FormValue>) => void

  /**
   * Callback to set loaded values.
   */
  setLoadedValues: (values: Record<string, FormValue>) => void

  /**
   * Callback to set selected entry ID.
   */
  setSelectedId: (id: string) => void

  /**
   * Callback to set entries.
   */
  setEntries: (entries: any[]) => void

  /**
   * Callback to refresh entries for a branch.
   */
  onEntriesRefresh: (branch: string) => Promise<void>

  /**
   * Callback to load comments for a branch.
   */
  onCommentsLoad: (branch: string) => Promise<void>

  /**
   * Callback to set busy state.
   */
  setBusy: (busy: boolean) => void

  /**
   * Current comments (for computing comment counts per branch).
   */
  comments: CommentThread[]

  /**
   * Callback when branch switch is complete (for external logic).
   */
  onBranchSwitch?: (branch: string) => void
}

export interface UseBranchManagerReturn {
  branchName: string
  setBranchName: (name: string) => void
  branches: BranchState[]
  branchSummaries: BranchSummary[]
  currentBranch: BranchState | undefined
  branchStatus: string
  handleBranchChange: (branch: string | null) => Promise<void>
  handleCreateBranch: (branch: {
    name: string
    title?: string
    description?: string
  }) => Promise<void>
  handleSubmit: (branchName: string) => Promise<void>
  handleWithdraw: (branchName: string) => Promise<void>
  handleRequestChanges: (branchName: string) => Promise<void>
  handleReloadBranchData: () => Promise<void>
  loadBranches: (options?: { refreshEntries?: boolean }) => Promise<void>
}

/**
 * Custom hook for managing git branches.
 *
 * Handles:
 * - Loading branches from API
 * - Branch switching with unsaved changes confirmation
 * - Creating new branches
 * - Branch workflow (submit, withdraw, request changes)
 * - URL synchronization for branch parameter
 *
 * @example
 * ```tsx
 * const {
 *   branchName,
 *   branches,
 *   currentBranch,
 *   handleBranchChange,
 *   handleCreateBranch,
 *   handleSubmit
 * } = useBranchManager({
 *   initialBranch: 'main',
 *   branchMode: 'collaboration',
 *   selectedId,
 *   drafts,
 *   loadedValues,
 *   setDrafts,
 *   setLoadedValues,
 *   setSelectedId,
 *   setEntries,
 *   onEntriesRefresh: refreshEntries,
 *   onCommentsLoad: loadComments,
 *   setBusy
 * })
 * ```
 */
export function useBranchManager(options: UseBranchManagerOptions): UseBranchManagerReturn {
  const [branchName, setBranchName] = useState<string>(options.initialBranch)
  const [branches, setBranches] = useState<BranchState[]>([])

  const currentBranch = branches.find((b) => b.branch.name === branchName)
  const branchStatus = currentBranch?.branch.status ?? 'editing'

  // Compute branch summaries with comment counts
  const branchSummaries = useMemo(() => {
    return branches.map((b) => {
      const branchComments = b.branch.name === branchName ? options.comments : []
      const unresolvedCount = branchComments.filter((t) => !t.resolved).length
      return {
        name: b.branch.name,
        status: b.branch.status,
        createdBy: b.branch.createdBy,
        updatedAt: b.branch.updatedAt,
        access: {
          users: b.branch.access.allowedUsers,
          groups: b.branch.access.allowedGroups,
        },
        pullRequestUrl: b.pullRequestUrl,
        pullRequestNumber: b.pullRequestNumber,
        commentCount: unresolvedCount,
      }
    })
  }, [branches, branchName, options.comments])

  const loadBranches = async (loadOptions?: { refreshEntries?: boolean }) => {
    options.setBusy(true)
    try {
      const res = await fetch('/api/canopycms/branches')
      if (res.status === 404) {
        // No branch endpoint available; stay branchless until user selects/creates via other means.
        setBranches([])
        return
      }
      if (!res.ok) throw new Error(`Failed to load branches: ${res.status}`)
      const payload = (await res.json()) as ApiResponse<{ branches: BranchState[] }>
      const list = ('data' in payload ? payload.data?.branches : (payload as any).branches) ?? []
      setBranches(list)
      const shouldRefresh = loadOptions?.refreshEntries ?? false
      if (shouldRefresh && branchName) {
        await options.onEntriesRefresh(branchName)
      }
    } catch (err) {
      console.error(err)
      notifications.show({ message: 'Failed to load branches', color: 'red' })
    } finally {
      options.setBusy(false)
    }
  }

  const performBranchSwitch = async (next: string) => {
    setBranchName(next)
    options.setDrafts({})
    options.setLoadedValues({})
    options.setSelectedId('')
    options.setEntries([])
    try {
      options.setBusy(true)
      await options.onEntriesRefresh(next)
      await options.onCommentsLoad(next)
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href)
        url.searchParams.set('branch', next)
        window.history.replaceState({}, '', url.toString())
      }
      options.onBranchSwitch?.(next)
    } catch (err) {
      console.error(err)
      notifications.show({ message: 'Failed to load entries for branch', color: 'red' })
    } finally {
      options.setBusy(false)
    }
  }

  const handleBranchChange = async (next: string | null) => {
    if (!next || next === branchName) return

    // Check for unsaved changes in the current entry
    if (options.selectedId && options.drafts[options.selectedId]) {
      // Consider it dirty if there's no loaded value (never saved) OR if draft differs from loaded
      const isDirty =
        !options.loadedValues[options.selectedId] ||
        JSON.stringify(options.drafts[options.selectedId]) !==
          JSON.stringify(options.loadedValues[options.selectedId])

      if (isDirty) {
        // Show confirmation modal
        return new Promise<void>((resolve, reject) => {
          modals.openConfirmModal({
            title: 'Unsaved Changes',
            children: (
              <Text size="sm">
                You have unsaved changes in the current entry. If you switch branches, your changes
                will be preserved on this browser, but won't be saved to the branch unless you
                explicitly click save.
              </Text>
            ),
            labels: { confirm: 'Switch Anyway', cancel: 'Stay' },
            confirmProps: { color: 'red' },
            onCancel: () => reject(new Error('User cancelled branch switch')),
            onConfirm: async () => {
              await performBranchSwitch(next)
              resolve()
            },
          })
        })
      }
    }

    await performBranchSwitch(next)
  }

  const handleCreateBranch = async (branch: {
    name: string
    title?: string
    description?: string
  }) => {
    options.setBusy(true)
    try {
      const res = await fetch('/api/canopycms/branches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branch: branch.name,
          title: branch.title,
          description: branch.description,
        }),
      })
      if (!res.ok) {
        const payload = await res.json()
        throw new Error(payload.error || 'Failed to create branch')
      }
      notifications.show({ message: `Branch "${branch.name}" created`, color: 'green' })
      await loadBranches({ refreshEntries: false })
      // Switch to the newly created branch
      await handleBranchChange(branch.name)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create branch'
      notifications.show({ message, color: 'red' })
    } finally {
      options.setBusy(false)
    }
  }

  const handleSubmit = async (branchNameToSubmit: string) => {
    options.setBusy(true)
    try {
      const res = await fetch(`/api/canopycms/${branchNameToSubmit}/submit`, { method: 'POST' })
      if (!res.ok) {
        const payload = await res.json()
        throw new Error(payload.error || 'Failed to submit branch')
      }
      notifications.show({ message: 'Branch submitted for review', color: 'green' })
      await loadBranches({ refreshEntries: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to submit branch'
      notifications.show({ message, color: 'red' })
    } finally {
      options.setBusy(false)
    }
  }

  const handleWithdraw = async (branchNameToWithdraw: string) => {
    options.setBusy(true)
    try {
      const res = await fetch(`/api/canopycms/${branchNameToWithdraw}/withdraw`, { method: 'POST' })
      if (!res.ok) {
        const payload = await res.json()
        throw new Error(payload.error || 'Failed to withdraw branch')
      }
      notifications.show({ message: 'Branch withdrawn', color: 'blue' })
      await loadBranches({ refreshEntries: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to withdraw branch'
      notifications.show({ message, color: 'red' })
    } finally {
      options.setBusy(false)
    }
  }

  const handleRequestChanges = async (branchNameForChanges: string) => {
    options.setBusy(true)
    try {
      const res = await fetch(`/api/canopycms/${branchNameForChanges}/request-changes`, {
        method: 'POST',
      })
      if (!res.ok) {
        const payload = await res.json()
        throw new Error(payload.error || 'Failed to request changes')
      }
      notifications.show({ message: 'Changes requested', color: 'orange' })
      await loadBranches({ refreshEntries: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to request changes'
      notifications.show({ message, color: 'red' })
    } finally {
      options.setBusy(false)
    }
  }

  const handleReloadBranchData = async () => {
    await loadBranches({ refreshEntries: true })
  }

  // Load branches on mount and when branchName changes
  useEffect(() => {
    loadBranches({ refreshEntries: Boolean(branchName) }).catch((err) => {
      console.error(err)
    })
    if (branchName) {
      options.onCommentsLoad(branchName).catch((err) => {
        console.error(err)
      })
    }
  }, [branchName])

  // Sync branch to URL parameter
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!branchName) return
    const url = new URL(window.location.href)
    const current = url.searchParams.get('branch')
    if (current !== branchName) {
      url.searchParams.set('branch', branchName)
      window.history.replaceState({}, '', url.toString())
    }
  }, [branchName])

  return {
    branchName,
    setBranchName,
    branches,
    branchSummaries,
    currentBranch,
    branchStatus,
    handleBranchChange,
    handleCreateBranch,
    handleSubmit,
    handleWithdraw,
    handleRequestChanges,
    handleReloadBranchData,
    loadBranches,
  }
}
