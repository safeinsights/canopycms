'use client'

import { useEffect, useMemo, useState } from 'react'
import { Text } from '@mantine/core'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import type { ConflictStatus, PullRequestState, SyncStatus } from '../../types'
import type { OperatingMode } from '../../operating-mode'
import type { CommentThread } from '../../comment-store'
import type { BranchListItem } from '../../api/branch'
import { useApiClient } from '../context'
// branch-name, NOT branch or the '../../paths' barrel: both of those pull
// node:fs/promises + node:path at the top level (path RESOLUTION helpers),
// which breaks adopters' production `next build` of the editor bundle.
// paths/branch-name.ts is the dependency-free home of sanitizeBranchName.
import { sanitizeBranchName } from '../../paths/branch-name'

/**
 * Helper function to show confirmation modal for branch submit action.
 */
const showSubmitConfirmation = (
  branchName: string,
  onConfirm: () => Promise<void>,
  onCancel: () => void,
) => {
  modals.openConfirmModal({
    title: 'Submit Branch for Review',
    children: (
      <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
        {`Are you sure you want to submit "${branchName}" for review?\n\nThis will:\n• Create a pull request for review\n• Change the branch status to "submitted"\n• Notify reviewers of pending changes`}
      </Text>
    ),
    labels: { confirm: 'Submit Branch', cancel: 'Cancel' },
    confirmProps: { color: 'brand' },
    onCancel,
    onConfirm,
  })
}

/**
 * Helper function to show confirmation modal for branch withdraw action.
 */
const showWithdrawConfirmation = (
  branchName: string,
  onConfirm: () => Promise<void>,
  onCancel: () => void,
) => {
  modals.openConfirmModal({
    title: 'Withdraw Branch from Review',
    children: (
      <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
        {`Are you sure you want to withdraw "${branchName}" from review?\n\nThis will:\n• Convert the pull request to a draft\n• Change the branch status back to "editing"\n• Remove from review queue`}
      </Text>
    ),
    labels: { confirm: 'Withdraw Branch', cancel: 'Cancel' },
    confirmProps: { color: 'orange' },
    onCancel,
    onConfirm,
  })
}

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
  pullRequestState?: PullRequestState
  mergedAt?: string
  /** Sync status for async GitHub operations (used when Lambda has no internet) */
  syncStatus?: SyncStatus
  /** Short, sanitized reason the last GitHub sync task failed (set alongside syncStatus: 'sync-failed') */
  syncFailureReason?: string
  /** Whether this branch has unresolved merge conflicts with the base branch */
  conflictStatus?: ConflictStatus
  /** ContentIds of entries where --theirs was applied during rebase; cleared on clean rebase */
  conflictFiles?: string[]
  commentCount: number
  isProtected: boolean
  readOnly: boolean
}

export interface UseBranchManagerOptions {
  /**
   * Initial branch name.
   */
  initialBranch: string

  /**
   * Operating mode (dev, etc.).
   */
  operatingMode: OperatingMode

  /**
   * Callback to set busy state.
   */
  setBusy: (busy: boolean) => void

  /**
   * Current comments (for computing comment counts per branch).
   */
  comments: CommentThread[]
}

export interface UseBranchManagerReturn {
  branchName: string
  setBranchName: (name: string) => void
  branches: BranchListItem[]
  branchSummaries: BranchSummary[]
  currentBranch: BranchListItem | undefined
  branchStatus: string
  handleSubmit: (branchName: string) => Promise<void>
  handleWithdraw: (branchName: string) => Promise<void>
  handleRequestChanges: (branchName: string) => Promise<void>
  handleDelete: (branchName: string) => Promise<void>
  handleReloadBranchData: () => Promise<void>
  loadBranches: () => Promise<void>
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
 *   operatingMode: 'collaboration',
 *   selectedPath,
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
  const apiClient = useApiClient()
  const [branchName, setBranchName] = useState<string>(options.initialBranch)
  const [branches, setBranches] = useState<BranchListItem[]>([])

  // Exact match first; fall back to comparing sanitized forms so a legacy
  // deep-link carrying the raw, unsanitized name (e.g. "?branch=feature%2Fx"
  // from before a branch was created, or from an old bookmark) still
  // resolves to the branch the server actually persisted (e.g. "feature-x").
  const currentBranch =
    branches.find((b) => b.name === branchName) ??
    branches.find((b) => b.name === sanitizeBranchName(branchName))
  const branchStatus = currentBranch?.status ?? 'editing'

  // Compute branch summaries with comment counts
  const branchSummaries = useMemo(() => {
    return branches.map((b) => {
      const branchComments = b.name === branchName ? options.comments : []
      const unresolvedCount = branchComments.filter((t) => !t.resolved).length
      return {
        name: b.name,
        status: b.status,
        createdBy: b.createdBy,
        updatedAt: b.updatedAt,
        access: {
          users: b.access.allowedUsers,
          groups: b.access.allowedGroups,
        },
        pullRequestUrl: b.pullRequestUrl,
        pullRequestNumber: b.pullRequestNumber,
        pullRequestState: b.pullRequestState,
        mergedAt: b.mergedAt,
        syncStatus: b.syncStatus,
        syncFailureReason: b.syncFailureReason,
        conflictStatus: b.conflictStatus,
        conflictFiles: b.conflictFiles,
        commentCount: unresolvedCount,
        isProtected: b.isProtected ?? false,
        readOnly: b.readOnly ?? false,
      }
    })
  }, [branches, branchName, options.comments])

  const loadBranches = async () => {
    options.setBusy(true)
    try {
      const result = await apiClient.branches.list()
      if (result.status === 404) {
        // No branch endpoint available; stay branchless. The branch dropdown
        // stays clickable so the user can open Manage Branches (which also
        // retries this load) and create or select a branch from there.
        setBranches([])
        return
      }
      if (!result.ok) {
        // Surface the server's reason (e.g. workspace provisioning failures
        // now arrive as 503s with the underlying git error)
        throw new Error(result.error ?? `Failed to load branches: ${result.status}`)
      }
      const list = result.data?.branches ?? []
      setBranches(list)
      // A previous failure may have left the sticky error toast up; clear it
      // now that loading succeeded (provisioning failures are often transient).
      notifications.hide('canopy-branches-load-failed')
      // No branch pinned via URL or client config — adopt the server's
      // effective default (the detected active branch in dev mode).
      if (!branchName && result.data?.defaultBranch) {
        setBranchName(result.data.defaultBranch)
      }
    } catch (err) {
      console.error(err)
      const message = err instanceof Error ? err.message : 'Failed to load branches'
      // Fixed id: retries update the existing toast instead of stacking; sticky
      // because the editor cannot function without the branch list.
      notifications.show({
        id: 'canopy-branches-load-failed',
        message,
        color: 'red',
        autoClose: false,
      })
    } finally {
      options.setBusy(false)
    }
  }

  const handleSubmit = async (branchNameToSubmit: string) => {
    return new Promise<void>((resolve, reject) => {
      showSubmitConfirmation(
        branchNameToSubmit,
        async () => {
          options.setBusy(true)
          try {
            const result = await apiClient.workflow.submit({
              branch: branchNameToSubmit,
            })
            if (!result.ok) {
              throw new Error(result.error || 'Failed to submit branch')
            }
            notifications.show({
              message: 'Branch submitted for review',
              color: 'green',
            })
            await loadBranches()
            resolve()
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to submit branch'
            notifications.show({ message, color: 'red' })
            reject(err)
          } finally {
            options.setBusy(false)
          }
        },
        () => reject(new Error('User cancelled submit')),
      )
    })
  }

  const handleWithdraw = async (branchNameToWithdraw: string) => {
    return new Promise<void>((resolve, reject) => {
      showWithdrawConfirmation(
        branchNameToWithdraw,
        async () => {
          options.setBusy(true)
          try {
            const result = await apiClient.workflow.withdraw({
              branch: branchNameToWithdraw,
            })
            if (!result.ok) {
              throw new Error(result.error || 'Failed to withdraw branch')
            }
            notifications.show({ message: 'Branch withdrawn', color: 'blue' })
            await loadBranches()
            resolve()
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to withdraw branch'
            notifications.show({ message, color: 'red' })
            reject(err)
          } finally {
            options.setBusy(false)
          }
        },
        () => reject(new Error('User cancelled withdraw')),
      )
    })
  }

  const handleRequestChanges = async (branchNameForChanges: string) => {
    options.setBusy(true)
    try {
      const result = await apiClient.workflow.requestChanges({ branch: branchNameForChanges })
      if (!result.ok) {
        throw new Error(result.error || 'Failed to request changes')
      }
      notifications.show({ message: 'Changes requested', color: 'orange' })
      await loadBranches()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to request changes'
      notifications.show({ message, color: 'red' })
    } finally {
      options.setBusy(false)
    }
  }

  const handleDelete = async (branchNameToDelete: string) => {
    options.setBusy(true)
    try {
      const result = await apiClient.branches.delete({
        branch: branchNameToDelete,
      })
      if (!result.ok) {
        throw new Error(result.error || 'Failed to delete branch')
      }
      notifications.show({ message: 'Branch deleted', color: 'green' })
      await loadBranches()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete branch'
      notifications.show({ message, color: 'red' })
    } finally {
      options.setBusy(false)
    }
  }

  const handleReloadBranchData = async () => {
    await loadBranches()
  }

  // Load branches on mount and when branchName changes

  useEffect(() => {
    loadBranches().catch(console.error)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadBranches would cause infinite loop
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
    handleSubmit,
    handleWithdraw,
    handleRequestChanges,
    handleDelete,
    handleReloadBranchData,
    loadBranches,
  }
}
