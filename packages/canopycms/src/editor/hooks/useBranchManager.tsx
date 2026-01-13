import { useEffect, useMemo, useState } from 'react'
import { Text } from '@mantine/core'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import type { BranchMetadata } from '../../types'
import type { OperatingMode } from '../../operating-mode'
import type { CommentThread } from '../../comment-store'
import { createApiClient } from '../../api'

// Lazy singleton - created on first access to pick up any fetch mocks in tests
let apiClient: ReturnType<typeof createApiClient> | null = null
function getApiClient() {
  if (!apiClient) {
    apiClient = createApiClient()
  }
  return apiClient
}

// For testing: reset the singleton to pick up new fetch mocks
export function resetApiClient() {
  apiClient = null
}

/**
 * Helper function to show confirmation modal for branch submit action.
 */
const showSubmitConfirmation = (branchName: string, onConfirm: () => Promise<void>, onCancel: () => void) => {
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
const showWithdrawConfirmation = (branchName: string, onConfirm: () => Promise<void>, onCancel: () => void) => {
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
  commentCount: number
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
  branches: BranchMetadata[]
  branchSummaries: BranchSummary[]
  currentBranch: BranchMetadata | undefined
  branchStatus: string
  handleSubmit: (branchName: string) => Promise<void>
  handleWithdraw: (branchName: string) => Promise<void>
  handleRequestChanges: (branchName: string) => Promise<void>
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
  const [branches, setBranches] = useState<BranchMetadata[]>([])

  const currentBranch = branches.find((b) => b.name === branchName)
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
        commentCount: unresolvedCount,
      }
    })
  }, [branches, branchName, options.comments])

  const loadBranches = async () => {
    options.setBusy(true)
    try {
      const result = await getApiClient().branches.list()
      if (result.status === 404) {
        // No branch endpoint available; stay branchless until user selects/creates via other means.
        setBranches([])
        return
      }
      if (!result.ok) throw new Error(`Failed to load branches: ${result.status}`)
      const list = result.data?.branches ?? []
      setBranches(list)
    } catch (err) {
      console.error(err)
      notifications.show({ message: 'Failed to load branches', color: 'red' })
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
            const result = await getApiClient().workflow.submit({ branch: branchNameToSubmit })
            if (!result.ok) {
              throw new Error(result.error || 'Failed to submit branch')
            }
            notifications.show({ message: 'Branch submitted for review', color: 'green' })
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
        () => reject(new Error('User cancelled submit'))
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
            const result = await getApiClient().workflow.withdraw({ branch: branchNameToWithdraw })
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
        () => reject(new Error('User cancelled withdraw'))
      )
    })
  }

  const handleRequestChanges = async (branchNameForChanges: string) => {
    options.setBusy(true)
    try {
      const result = await getApiClient().workflow.requestChanges({ branch: branchNameForChanges }, {})
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

  const handleReloadBranchData = async () => {
    await loadBranches()
  }

  // Load branches on mount and when branchName changes
  useEffect(() => {
    loadBranches().catch(console.error)
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
    handleReloadBranchData,
    loadBranches,
  }
}
