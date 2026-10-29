import { useState } from 'react'
import { openConfirm } from '../utils/confirm-modal'
import { notifications } from '@mantine/notifications'
import { Text } from '@mantine/core'
import type { BranchListItem } from '../../api/branch'
import { useApiClient } from '../context'
import { requestBranchCreate, type CreateRefusal } from './create-branch-request'
import type { UnsavedSummary } from './useDraftManager'
import { displayBranchName } from '../branch-names'
import { writeEditorUrl } from './editor-history'
import { parseCreatedBranchName } from '../../paths/validation'

export interface UseBranchActionsOptions {
  branchName: string
  /** What the dialogs call the open branch, when it is not `branchName`. */
  branchLabel?: string
  setBranchName: (name: string) => void
  /** From useDraftManager's `resolveUnsaved`: what a branch-level action would leave behind. */
  getUnsaved: () => Promise<UnsavedSummary>
  onReloadBranches: () => Promise<void>
  /** Receives the branch the server just created, so it can be shown before any listing includes it. */
  onBranchCreated: (branch: BranchListItem) => void
  onBranchSwitch?: (branch: string) => void
  /** What `?branch=` carries for a branch (its short name); defaults to the name as given. */
  urlBranchName?: (branch: string) => string
  /** The current user; a create the server never answered adopts only a listed branch they made. */
  userId?: string
}

/** `push: false` for a switch a Back or Forward makes, which arrived at its history entry already. */
export interface BranchChangeOptions {
  push?: boolean
}

export interface UseBranchActionsReturn {
  handleBranchChange: (branch: string | null, options?: BranchChangeOptions) => Promise<void>
  /** True when nothing is unsaved or the user accepted the warning. Run before any in-flight UI. */
  confirmCreate: () => Promise<boolean>
  handleCreateBranch: (branch: {
    name: string
    title?: string
    description?: string
  }) => Promise<boolean | CreateRefusal>
  /** True while the unsaved-changes confirm is on screen. */
  confirmOpen: boolean
}

const MAX_LISTED_LABELS = 5

/** 'Unsaved changes in: "A", "B".' */
export const describeUnsaved = ({ labels }: UnsavedSummary): string => {
  if (labels.length === 0) return 'You have unsaved changes.'
  const shown = labels
    .slice(0, MAX_LISTED_LABELS)
    .map((label) => `"${label}"`)
    .join(', ')
  const rest = labels.length - MAX_LISTED_LABELS
  return `Unsaved changes in: ${shown}${rest > 0 ? ` and ${rest} more` : ''}.`
}

/**
 * Custom hook for branch navigation actions with dirty check support.
 */
export function useBranchActions(options: UseBranchActionsOptions): UseBranchActionsReturn {
  const apiClient = useApiClient()
  const [confirmOpen, setConfirmOpen] = useState(false)

  const performBranchSwitch = (next: string, urlName?: string, push = true) => {
    options.setBranchName(next)

    // Its own history entry, unless a Back or Forward made it: that entry's URL is replaced.
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      url.searchParams.set('branch', urlName ?? options.urlBranchName?.(next) ?? next)
      writeEditorUrl(url.toString(), push)
    }
    options.onBranchSwitch?.(next)
  }

  const confirmIfDirty = async (question: string): Promise<boolean> => {
    const unsaved = await options.getUnsaved()
    if (unsaved.count === 0) return true

    return new Promise<boolean>((resolve) => {
      const settle = (value: boolean) => {
        // Mantine calls onClose and onCancel from its modals reducer, which runs while
        // ModalsProvider renders, so a setState here must be deferred; resolving needs no deferral.
        queueMicrotask(() => setConfirmOpen(false))
        resolve(value)
      }
      setConfirmOpen(true)
      openConfirm({
        title: 'Unsaved Changes',
        // Drafts are stored per branch, so leaving does not lose them.
        children: (
          <Text size="sm">
            {describeUnsaved(unsaved)} Your drafts stay on “
            {options.branchLabel ?? options.branchName}” and come back when you return. {question}
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

  const handleBranchChange = async (next: string | null, change: BranchChangeOptions = {}) => {
    if (!next || next === options.branchName) return

    const confirmed = await confirmIfDirty('Switch branches anyway?')
    if (!confirmed) throw new Error('User cancelled branch switch')

    performBranchSwitch(next, undefined, change.push ?? true)
  }

  const confirmCreate = () => confirmIfDirty('Create the new branch anyway?')

  /**
   * Resolves true when the branch was created and switched to, false when it was not and a toast
   * says why, or a {@link CreateRefusal} when the server refused the name.
   */
  const handleCreateBranch = async (branch: {
    name: string
    title?: string
    description?: string
  }): Promise<boolean | CreateRefusal> => {
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
        if (outcome.refused) return { refusal: outcome.message }
        throw new Error(outcome.message)
      }

      const created = outcome.branch
      if (created) options.onBranchCreated(created)

      // The server adds the namespace, which the editor is never told; its short name resolves too.
      const typed = parseCreatedBranchName(branch.name)
      const createdName = created?.name ?? (typed.ok ? typed.shortName : branch.name)
      const createdLabel = created
        ? displayBranchName(created)
        : typed.ok
          ? typed.shortName
          : branch.name
      notifications.show({ message: `Branch “${createdLabel}” created`, color: 'green' })

      // A listing may not hold it yet, so its own short name stands in for the lookup.
      performBranchSwitch(createdName, created?.shortName)

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
