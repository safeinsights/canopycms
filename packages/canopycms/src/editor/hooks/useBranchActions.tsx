import { useState } from 'react'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { Text } from '@mantine/core'
import type { BranchListItem } from '../../api/branch'
import { useApiClient } from '../context'
import type { UnsavedSummary } from './useDraftManager'

export interface UseBranchActionsOptions {
  branchName: string
  setBranchName: (name: string) => void
  /** From useDraftManager's `resolveUnsaved`: what a branch-level action would leave behind. */
  getUnsaved: () => Promise<UnsavedSummary>
  onReloadBranches: () => Promise<void>
  /** Receives the branch the server just created, so it can be shown before any listing includes it. */
  onBranchCreated: (branch: BranchListItem) => void
  onBranchSwitch?: (branch: string) => void
}

export interface UseBranchActionsReturn {
  handleBranchChange: (branch: string | null) => Promise<void>
  /** True when nothing is unsaved or the user accepted the warning. Run before any in-flight UI. */
  confirmCreate: () => Promise<boolean>
  handleCreateBranch: (branch: {
    name: string
    title?: string
    description?: string
  }) => Promise<boolean>
  /** True while the unsaved-changes confirm is on screen. */
  confirmOpen: boolean
}

const MAX_LISTED_LABELS = 5

/** "Unsaved changes in: A, B." */
const describeUnsaved = ({ labels }: UnsavedSummary): string => {
  if (labels.length === 0) return 'You have unsaved changes.'
  const shown = labels.slice(0, MAX_LISTED_LABELS).join(', ')
  const rest = labels.length - MAX_LISTED_LABELS
  return `Unsaved changes in: ${shown}${rest > 0 ? ` and ${rest} more` : ''}.`
}

/**
 * Custom hook for branch navigation actions with dirty check support.
 */
export function useBranchActions(options: UseBranchActionsOptions): UseBranchActionsReturn {
  const apiClient = useApiClient()
  const [confirmOpen, setConfirmOpen] = useState(false)

  const performBranchSwitch = (next: string) => {
    options.setBranchName(next)

    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      url.searchParams.set('branch', next)
      window.history.replaceState({}, '', url.toString())
    }
    options.onBranchSwitch?.(next)
  }

  const confirmIfDirty = async (question: string): Promise<boolean> => {
    const unsaved = await options.getUnsaved()
    if (unsaved.count === 0) return true

    return new Promise<boolean>((resolve) => {
      const settle = (value: boolean) => {
        // Mantine runs these callbacks while ModalsProvider renders, where a
        // setState on this component is illegal; the promise needs no such deferral.
        queueMicrotask(() => setConfirmOpen(false))
        resolve(value)
      }
      setConfirmOpen(true)
      modals.openConfirmModal({
        title: 'Unsaved Changes',
        // Drafts are stored per branch, so leaving does not lose them.
        children: (
          <Text size="sm">
            {describeUnsaved(unsaved)} Your drafts stay on “{options.branchName}” and come back when
            you return. {question}
          </Text>
        ),
        labels: { confirm: 'Continue Anyway', cancel: 'Cancel' },
        confirmProps: { color: 'red' },
        onCancel: () => settle(false),
        onConfirm: () => settle(true),
        // Escape and overlay dismissals fire only onClose. Mantine also calls it
        // right after onConfirm, which is harmless: a promise settles once.
        onClose: () => settle(false),
      })
    })
  }

  const handleBranchChange = async (next: string | null) => {
    if (!next || next === options.branchName) return

    const confirmed = await confirmIfDirty('Switch branches anyway?')
    if (!confirmed) throw new Error('User cancelled branch switch')

    performBranchSwitch(next)
  }

  const confirmCreate = () => confirmIfDirty('Create the new branch anyway?')

  /** Resolves true when the branch was created and switched to, false when it was not. */
  const handleCreateBranch = async (branch: {
    name: string
    title?: string
    description?: string
  }): Promise<boolean> => {
    try {
      const result = await apiClient.branches.create({
        branch: branch.name,
        title: branch.title,
        description: branch.description,
      })
      if (!result.ok) {
        throw new Error(result.error || 'Failed to create branch')
      }

      const created = result.data?.branch
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
    confirmCreate,
    handleCreateBranch,
    confirmOpen,
  }
}
