import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { Text } from '@mantine/core'
import { useApiClient } from '../context'

export interface UseBranchActionsOptions {
  branchName: string
  setBranchName: (name: string) => void
  isAnyDirty: () => boolean // From useDraftManager
  onReloadBranches: () => Promise<void>
  onBranchSwitch?: (branch: string) => void
}

export interface UseBranchActionsReturn {
  handleBranchChange: (branch: string | null) => Promise<void>
  handleCreateBranch: (branch: {
    name: string
    title?: string
    description?: string
  }) => Promise<void>
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
      })
    })
  }

  const handleBranchChange = async (next: string | null) => {
    if (!next || next === options.branchName) return

    const confirmed = await confirmIfDirty('You have unsaved changes. Switch branches anyway?')
    if (!confirmed) throw new Error('User cancelled branch switch')

    performBranchSwitch(next)
  }

  const handleCreateBranch = async (branch: {
    name: string
    title?: string
    description?: string
  }) => {
    const confirmed = await confirmIfDirty('Create new branch without saving changes?')
    if (!confirmed) return

    try {
      const result = await apiClient.branches.create({
        branch: branch.name,
        title: branch.title,
        description: branch.description,
      })
      if (!result.ok) {
        throw new Error(result.error || 'Failed to create branch')
      }

      // The server sanitizes the branch name (e.g. "feature/x" -> "feature-x")
      // before persisting it. Adopt the canonical name from the response so
      // the client doesn't end up stuck on a name the server never saved.
      const createdName = result.data?.branch?.name ?? branch.name
      notifications.show({
        message:
          createdName === branch.name
            ? `Branch "${createdName}" created`
            : `Branch "${createdName}" created (renamed from "${branch.name}")`,
        color: 'green',
      })
      await options.onReloadBranches()

      // Switch to new branch (already confirmed dirty check)
      performBranchSwitch(createdName)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create branch'
      notifications.show({ message, color: 'red' })
    }
  }

  return {
    handleBranchChange,
    handleCreateBranch,
  }
}
