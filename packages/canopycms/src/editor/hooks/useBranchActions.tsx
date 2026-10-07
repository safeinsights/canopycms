import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { Text } from '@mantine/core'
import type { BranchListItem } from '../../api/branch'
import { useApiClient } from '../context'
import { requestBranchCreate } from './create-branch-request'

export interface UseBranchActionsOptions {
  branchName: string
  setBranchName: (name: string) => void
  isAnyDirty: () => boolean // From useDraftManager
  onReloadBranches: () => Promise<void>
  /** Receives the branch the server just created, so it can be shown before any listing includes it. */
  onBranchCreated: (branch: BranchListItem) => void
  onBranchSwitch?: (branch: string) => void
  /** The current user; a create the server never answered adopts only a listed branch they made. */
  userId?: string
}

export interface UseBranchActionsReturn {
  handleBranchChange: (branch: string | null) => Promise<void>
  handleCreateBranch: (branch: {
    name: string
    title?: string
    description?: string
  }) => Promise<boolean>
}

/**
 * Custom hook for branch navigation actions with dirty check support.
 */
export function useBranchActions(options: UseBranchActionsOptions): UseBranchActionsReturn {
  const apiClient = useApiClient()

  const performBranchSwitch = (next: string) => {
    options.setBranchName(next)

    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      url.searchParams.set('branch', next)
      window.history.replaceState({}, '', url.toString())
    }
    options.onBranchSwitch?.(next)
  }

  const confirmIfDirty = async (message: string): Promise<boolean> => {
    if (!options.isAnyDirty()) return true

    return new Promise<boolean>((resolve) => {
      modals.openConfirmModal({
        title: 'Unsaved Changes',
        children: <Text size="sm">{message}</Text>,
        labels: { confirm: 'Continue Anyway', cancel: 'Cancel' },
        confirmProps: { color: 'red' },
        onCancel: () => resolve(false),
        onConfirm: () => resolve(true),
        // Escape and overlay dismissals fire only onClose. Mantine also calls it
        // right after onConfirm, which is harmless: a promise settles once.
        onClose: () => resolve(false),
      })
    })
  }

  const handleBranchChange = async (next: string | null) => {
    if (!next || next === options.branchName) return

    const confirmed = await confirmIfDirty('You have unsaved changes. Switch branches anyway?')
    if (!confirmed) throw new Error('User cancelled branch switch')

    performBranchSwitch(next)
  }

  /** Resolves true when the branch was created and switched to, false when it was not. */
  const handleCreateBranch = async (branch: {
    name: string
    title?: string
    description?: string
  }): Promise<boolean> => {
    const confirmed = await confirmIfDirty('Create new branch without saving changes?')
    if (!confirmed) return false

    try {
      const outcome = await requestBranchCreate(
        apiClient,
        {
          branch: branch.name,
          title: branch.title,
          description: branch.description,
        },
        options.userId,
      )
      if (outcome.kind === 'failed') {
        throw new Error(outcome.message)
      }

      const created = outcome.branch
      if (created) options.onBranchCreated(created)

      // The server sanitizes the branch name (e.g. "feature/x" -> "feature-x")
      // before persisting it. Adopt the canonical name from the response so
      // the client doesn't end up stuck on a name the server never saved.
      const createdName = created?.name ?? branch.name
      notifications.show({
        message:
          createdName === branch.name
            ? `Branch "${createdName}" created`
            : `Branch "${createdName}" created (renamed from "${branch.name}")`,
        color: 'green',
      })

      // Switch to new branch (already confirmed dirty check)
      performBranchSwitch(createdName)

      // Not awaited: a listing can lag the create, and the switch must not wait
      // on it. loadBranches reports its own failures and never rejects.
      void options.onReloadBranches()
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create branch'
      notifications.show({ message, color: 'red' })
      return false
    }
  }

  return {
    handleBranchChange,
    handleCreateBranch,
  }
}
