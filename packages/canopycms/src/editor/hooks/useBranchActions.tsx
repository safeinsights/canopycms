import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { Text } from '@mantine/core'

export interface UseBranchActionsOptions {
  branchName: string
  setBranchName: (name: string) => void
  isSelectedDirty: () => boolean  // From useDraftManager
  onReloadBranches: () => Promise<void>
  onBranchSwitch?: (branch: string) => void
}

export interface UseBranchActionsReturn {
  handleBranchChange: (branch: string | null) => Promise<void>
  handleCreateBranch: (branch: { name: string; title?: string; description?: string }) => Promise<void>
}

/**
 * Custom hook for branch navigation actions with dirty check support.
 *
 * Handles:
 * - Branch switching with unsaved changes confirmation
 * - Creating new branches with dirty check
 *
 * @example
 * ```tsx
 * const { handleBranchChange, handleCreateBranch } = useBranchActions({
 *   branchName,
 *   setBranchName,
 *   isSelectedDirty,
 *   onReloadBranches
 * })
 * ```
 */
export function useBranchActions(options: UseBranchActionsOptions): UseBranchActionsReturn {
  // Helper: Perform branch switch with URL update
  const performBranchSwitch = (next: string) => {
    // Update branchName state - hooks will react:
    // - useEntryManager clears selectedId and refreshes entries
    // - useDraftManager clears drafts/loadedValues
    // - useCommentSystem loads comments
    options.setBranchName(next)

    // Update URL
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      url.searchParams.set('branch', next)
      window.history.replaceState({}, '', url.toString())
    }
    options.onBranchSwitch?.(next)
  }

  // Helper: Check for dirty state and show modal
  const confirmIfDirty = async (message: string): Promise<boolean> => {
    if (!options.isSelectedDirty()) return true

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

    // Create the branch via API
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
      await options.onReloadBranches()

      // Switch to new branch (already confirmed dirty check)
      performBranchSwitch(branch.name)
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
