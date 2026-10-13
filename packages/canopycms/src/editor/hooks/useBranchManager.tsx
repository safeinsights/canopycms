'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import { Alert, Stack, Text } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'
import { openConfirm } from '../utils/confirm-modal'
import { EDITOR_ACTIONS } from '../copy'
import { notifications } from '@mantine/notifications'
import type { ConflictStatus, PullRequestState, SyncStatus } from '../../types'
import type { OperatingMode } from '../../operating-mode'
import type { CommentThread } from '../../comment-store'
import type { BranchListItem } from '../../api/branch'
import { useApiClient } from '../context'
import { BRANCHES_KEY, fetchBranches, useBranchesData, type BranchesData } from './useBranchesData'
// branch-name, NOT branch or the '../../paths' barrel: both of those pull
// node:fs/promises + node:path at the top level (path RESOLUTION helpers),
// which breaks adopters' production `next build` of the editor bundle.
// paths/branch-name.ts is the dependency-free home of sanitizeBranchName.
import { sanitizeBranchName } from '../../paths/branch-name'
import { RetryToastMessage } from '../components/RetryToastMessage'
import { isNonApiResponse } from '../../api/client'
import { isGatewayFailure, isUnanswered, UnansweredError } from '../unanswered'
import type { ApiResponse } from '../../api/types'
import type { UnsavedSummary } from './useDraftManager'
import { describeUnsaved } from './useBranchActions'

const BRANCHES_LOAD_FAILED_TOAST_ID = 'canopy-branches-load-failed'
const BRANCH_OUTCOME_UNKNOWN_TOAST_ID = 'canopy-branch-outcome-unknown'

/** The error a refused branch action throws; a gateway's 5xx says nothing of whether it ran. */
function actionError(result: ApiResponse, fallback: string): Error {
  return isGatewayFailure(result) ? new UnansweredError() : new Error(result.error || fallback)
}

/** @internal Exported for tests. */
export const branchActionOutcomeUnknown = (action: string) =>
  `${action} may have gone through even though the server didn't answer. Check the branch's status before trying again.`

/**
 * Wire a confirm modal's exits so exactly ONE of {confirmed, dismissed} runs,
 * whichever happens first.
 *
 * Neither Mantine callback is the "user declined" signal on its own, in
 * opposite directions: `onCancel` does NOT fire for an Escape or overlay
 * dismissal (so a caller waiting on it alone waits forever), while `onClose`
 * fires for EVERY exit including a confirm -- Mantine closes the modal right
 * after calling `onConfirm`, and does not await it, so a bare `onClose`
 * handler would settle the caller's promise before the confirmed work had
 * even run. Claiming the first exit resolves both.
 */
const confirmModalHandlers = (onConfirm: () => Promise<void>, onDismiss: () => void) => {
  let settled = false
  const claim = (): boolean => {
    if (settled) return false
    settled = true
    return true
  }
  return {
    onConfirm: () => {
      // Not awaited by Mantine either way; the handlers below own their own
      // error reporting, so nothing here can reject.
      if (claim()) void onConfirm()
    },
    onCancel: () => {
      if (claim()) onDismiss()
    },
    onClose: () => {
      if (claim()) onDismiss()
    },
  }
}

/**
 * With `unsaved` edits on the branch, the dialog says they are left out: a submit sends only what
 * is saved, and the branch is read-only in review, so they wait as drafts until it is withdrawn.
 */
const showSubmitConfirmation = (
  branchName: string,
  unsaved: UnsavedSummary | undefined,
  onConfirm: () => Promise<void>,
  onDismiss: () => void,
) => {
  const leftOut = unsaved && unsaved.count > 0 ? unsaved : undefined
  openConfirm({
    title: EDITOR_ACTIONS.submitForReview,
    children: (
      <Stack gap="sm">
        {leftOut && (
          <Alert
            color="yellow"
            icon={<IconAlertTriangle size={16} />}
            title={`${leftOut.count} ${leftOut.count === 1 ? "entry has unsaved changes that won't" : "entries have unsaved changes that won't"} be submitted`}
            data-testid="submit-unsaved-warning"
          >
            {describeUnsaved(leftOut)} To include them, cancel and save first. Submitted without
            them, they stay as drafts while the branch is in review.
          </Alert>
        )}
        <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
          {`Submit "${branchName}" for review?\n\nThis will:\n• Create a pull request for review\n• Change the branch status to "submitted"\n• Notify reviewers of pending changes`}
        </Text>
      </Stack>
    ),
    labels: {
      confirm: leftOut ? 'Submit anyway' : EDITOR_ACTIONS.submitForReview,
      cancel: 'Cancel',
    },
    confirmProps: { color: 'brand', 'data-testid': 'confirm-submit-branch' },
    ...confirmModalHandlers(onConfirm, onDismiss),
  })
}

/** What the withdraw and delete dialogs say about the branch's pull request. */
type BranchPullRequest = Pick<BranchListItem, 'pullRequestNumber' | 'pullRequestState'>

/**
 * The withdraw dialog's pull-request bullet, matching what api/branch-withdraw.ts does: an open
 * PR becomes a draft; a closed one is left alone and its number dropped from the branch, so a
 * resubmit opens a new one. A merged PR archives its branch, which withdraw refuses, so that
 * bullet is only seen on a listing that lags.
 * @internal Exported for tests.
 */
export function withdrawPullRequestBullet(pr: BranchPullRequest): string | undefined {
  if (!pr.pullRequestNumber) return undefined
  const label = `pull request #${pr.pullRequestNumber}`
  if (pr.pullRequestState === 'closed') {
    return `Leave the closed ${label} as it is; submitting again opens a new one`
  }
  if (pr.pullRequestState === 'merged') return `Leave the merged ${label} as it is`
  return `Convert ${label} to a draft`
}

const showWithdrawConfirmation = (
  branchName: string,
  pr: BranchPullRequest,
  onConfirm: () => Promise<void>,
  onDismiss: () => void,
) => {
  const bullets = [
    withdrawPullRequestBullet(pr),
    'Change the branch status back to "editing"',
    'Remove from review queue',
  ].filter((b): b is string => b !== undefined)
  openConfirm({
    title: EDITOR_ACTIONS.withdrawFromReview,
    children: (
      <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
        {`Withdraw "${branchName}" from review?\n\nThis will:\n${bullets.map((b) => `• ${b}`).join('\n')}`}
      </Text>
    ),
    labels: { confirm: EDITOR_ACTIONS.withdrawFromReview, cancel: 'Cancel' },
    confirmProps: { color: 'orange', 'data-testid': 'confirm-withdraw-branch' },
    ...confirmModalHandlers(onConfirm, onDismiss),
  })
}

const showRequestChangesConfirmation = (
  branchName: string,
  onConfirm: () => Promise<void>,
  onDismiss: () => void,
) => {
  openConfirm({
    title: EDITOR_ACTIONS.requestChanges,
    children: (
      <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
        {`Send "${branchName}" back to its editor?\n\nThis will:\n• Change the branch status back to "editing"\n• Let its editor change it and submit again`}
      </Text>
    ),
    labels: { confirm: EDITOR_ACTIONS.requestChanges, cancel: 'Cancel' },
    confirmProps: { color: 'red', 'data-testid': 'confirm-request-changes' },
    ...confirmModalHandlers(onConfirm, onDismiss),
  })
}

/**
 * Delete is the one irreversible branch action: it unlinks branch.json and removes the clone,
 * the local mirror's head and, for a branch with a PR, the GitHub branch. BranchManager.tsx's
 * delete menu item calls `onDelete` directly, so this dialog is the only confirmation; `color:
 * 'red'` matches that item.
 */
const showDeleteConfirmation = (
  branchName: string,
  pr: BranchPullRequest,
  onConfirm: () => Promise<void>,
  onDismiss: () => void,
) => {
  // The server deletes the GitHub branch only for a branch with a PR (api/github-sync.ts's
  // syncDeleteRemoteBranch); GitHub closes a PR whose branch is deleted.
  const bullets = [
    'Permanently remove the branch and its clone',
    pr.pullRequestNumber
      ? `Delete its branch on GitHub too, which closes pull request #${pr.pullRequestNumber} if it is still open`
      : undefined,
    'Discard any unsaved or unmerged changes',
  ].filter((b): b is string => b !== undefined)
  openConfirm({
    title: 'Delete branch',
    children: (
      <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
        {`Delete "${branchName}"?\n\nThis will:\n${bullets.map((b) => `• ${b}`).join('\n')}\n\nThis cannot be undone.`}
      </Text>
    ),
    labels: { confirm: 'Delete branch', cancel: 'Cancel' },
    // data-testid is load-bearing, not decoration: the e2e helper
    // (apps/test-app/e2e/fixtures/branch-page.ts's deleteBranch) already
    // anticipated a delete confirmation and clicks
    // [data-testid="confirm-delete-branch"] when it appears. Without this the
    // modal opens, nothing dismisses it, and the branch never disappears.
    confirmProps: { color: 'red', 'data-testid': 'confirm-delete-branch' },
    ...confirmModalHandlers(onConfirm, onDismiss),
  })
}

/**
 * How long a branch this session created stays overlaid on listings. Each warm
 * server container caches the shared filesystem separately, so for its
 * attribute/dentry cache window (~60s, see docs/concurrency.md window A) a
 * listing can lack the branch even after another container's listing showed
 * it. Twice that absorbs request latency; past it, listings alone decide.
 * @internal Exported only for the test that pins it.
 */
export const CREATED_BRANCH_GRACE_MS = 120_000

/** A branch this session created: the create response's copy, then the last copy a listing showed. */
interface PendingBranch {
  branch: BranchListItem
  addedAt: number
}

/** The server listing plus any pending branches it lacks; the server's copy always wins. */
function mergePendingBranches(
  listed: BranchListItem[],
  pending: PendingBranch[],
): BranchListItem[] {
  const listedNames = new Set(listed.map((b) => b.name))
  const missing = pending.filter((p) => !listedNames.has(p.branch.name))
  return missing.length === 0 ? listed : [...listed, ...missing.map((p) => p.branch)]
}

/**
 * Applies one received listing to the pending branches: drops those it arrived
 * past the grace window for, and takes the listing's copy of the rest. Written
 * so a listing with no arrival time (NaN) drops nothing.
 */
function reconcilePendingBranches(
  pending: PendingBranch[],
  listed: BranchListItem[],
  receivedAt: number,
): PendingBranch[] {
  const listedByName = new Map(listed.map((b) => [b.name, b]))
  let changed = false
  const next: PendingBranch[] = []
  for (const p of pending) {
    if (receivedAt - p.addedAt > CREATED_BRANCH_GRACE_MS) {
      changed = true
      continue
    }
    const listedCopy = listedByName.get(p.branch.name)
    if (listedCopy && listedCopy !== p.branch) {
      changed = true
      next.push({ branch: listedCopy, addedAt: p.addedAt })
    } else {
      next.push(p)
    }
  }
  return changed ? next : pending
}

interface BranchSummary {
  name: string
  status: string
  createdBy?: string
  updatedAt?: string
  access: {
    users: string[] | undefined
    groups: string[] | undefined
    withheldUsers: number | undefined
    withheldGroups: number | undefined
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
  /**
   * Server-computed: content writes are rejected, because the branch is the
   * read-only base branch OR its status is past 'editing'. `readOnly` still
   * says WHICH, for banner copy.
   */
  writeBlocked: boolean
  /**
   * Server-computed compound submit rule: true when the branch can never be
   * submitted for review, for EITHER reason -- it is the protected base
   * branch, or its workflow status has moved past 'editing'. Mirrors
   * `writeBlocked`'s shape (a base-branch half + a status half, combined),
   * except this one is built from `isProtected`/`submitBlocked` (both modes)
   * rather than `readOnly` (prod-only) -- see
   * `BranchWriteProtection.submitBlockedIncludingStatus` for why those two
   * compounds are genuinely different predicates, not duplicates of each
   * other. Consumed as-is by `BranchManager.tsx`'s `canSubmit`; do not
   * re-derive the status/protection halves client-side.
   */
  submitBlocked: boolean
}

export interface UseBranchManagerOptions {
  initialBranch: string

  operatingMode: OperatingMode

  setBusy: (busy: boolean) => void

  comments: CommentThread[]

  /** What is unsaved on the open branch (useDraftManager's `resolveUnsaved`), named before a submit. */
  getUnsaved?: () => Promise<UnsavedSummary>
}

export interface UseBranchManagerReturn {
  branchName: string
  setBranchName: (name: string) => void
  branches: BranchListItem[]
  branchSummaries: BranchSummary[]
  currentBranch: BranchListItem | undefined
  /** Shows a branch the server just created before any listing includes it. */
  addCreatedBranch: (branch: BranchListItem) => void
  handleSubmit: (branchName: string) => Promise<void>
  handleWithdraw: (branchName: string) => Promise<void>
  handleRequestChanges: (branchName: string) => Promise<void>
  handleDelete: (branchName: string) => Promise<void>
  handleReloadBranchData: () => Promise<void>
  loadBranches: () => Promise<void>
}

/**
 * Custom hook for managing git branches.
 */
export function useBranchManager(options: UseBranchManagerOptions): UseBranchManagerReturn {
  const apiClient = useApiClient()
  const { cache, mutate: globalMutate } = useSWRConfig()
  const [branchName, setBranchName] = useState<string>(options.initialBranch)
  const {
    data: branchesData,
    error: branchesError,
    isValidating: branchesIsValidating,
  } = useBranchesData(apiClient)
  const [pendingBranches, setPendingBranches] = useState<PendingBranch[]>([])
  const branches = useMemo(
    () => mergePendingBranches(branchesData?.branches ?? [], pendingBranches),
    [branchesData, pendingBranches],
  )

  const addCreatedBranch = useCallback((branch: BranchListItem) => {
    setPendingBranches((prev) => [
      ...prev.filter((p) => p.branch.name !== branch.name),
      { branch, addedAt: Date.now() },
    ])
  }, [])

  const forgetCreatedBranch = (name: string) => {
    setPendingBranches((prev) => {
      const kept = prev.filter((p) => p.branch.name !== name)
      return kept.length === prev.length ? prev : kept
    })
  }

  // After a workflow action, a pending branch's overlaid copy is stale. The
  // server's returned copy replaces it, so a listing that still lacks the
  // branch shows its new status instead of hiding it; without one, forgetting
  // it fails closed rather than showing the pre-action state.
  const updateCreatedBranch = (name: string, branch: BranchListItem | undefined) => {
    if (!branch) {
      forgetCreatedBranch(name)
      return
    }
    setPendingBranches((prev) =>
      prev.some((p) => p.branch.name === name)
        ? prev.map((p) => (p.branch.name === name ? { ...p, branch } : p))
        : prev,
    )
  }

  // Each received listing is a new `branchesData` (see `BranchesData.receivedAt`);
  // the grace window is measured to its arrival.
  useEffect(() => {
    if (!branchesData) return
    setPendingBranches((prev) =>
      reconcilePendingBranches(prev, branchesData.branches, branchesData.receivedAt),
    )
  }, [branchesData])

  // Adopt the server's default branch once data arrives, if nothing pinned one.
  useEffect(() => {
    if (!branchName && branchesData?.defaultBranch) {
      setBranchName(branchesData.defaultBranch)
    }
  }, [branchesData, branchName])

  // One toast, replaced on each failure (a shown id ignores `show`); sticky because the editor
  // cannot function without the branch list.
  const showBranchesLoadFailed = (message: string) => {
    notifications.hide(BRANCHES_LOAD_FAILED_TOAST_ID)
    notifications.show({
      id: BRANCHES_LOAD_FAILED_TOAST_ID,
      title: 'Could not load branches',
      message: (
        <RetryToastMessage
          message={message}
          onRetry={() => {
            notifications.hide(BRANCHES_LOAD_FAILED_TOAST_ID)
            void reloadBranches()
          }}
        />
      ),
      color: 'red',
      autoClose: false,
    })
  }

  // Surfaces/clears the sticky error toast the same way loadBranches() does.
  useEffect(() => {
    if (branchesError) {
      console.error(branchesError)
      showBranchesLoadFailed(
        branchesError instanceof Error ? branchesError.message : 'Failed to load branches',
      )
    } else if (branchesData) {
      // A previous failure may have left the sticky error toast up; clear it
      // now that loading succeeded (provisioning failures are often transient).
      notifications.hide(BRANCHES_LOAD_FAILED_TOAST_ID)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- showBranchesLoadFailed is new every render and reads nothing that changes
  }, [branchesData, branchesError])

  // Mirrors the automatic load's in-flight state onto the shared busy flag,
  // matching loadBranches()'s own setBusy bracket below for explicit reloads.
  useEffect(() => {
    options.setBusy(branchesIsValidating)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- options is a new object every Editor.tsx render; only setBusy (a stable setState) matters here
  }, [branchesIsValidating, options.setBusy])

  // Exact match first; fall back to comparing sanitized forms so a legacy
  // deep-link carrying the raw, unsanitized name (e.g. "?branch=feature%2Fx"
  // from before a branch was created, or from an old bookmark) still
  // resolves to the branch the server actually persisted (e.g. "feature-x").
  const currentBranch =
    branches.find((b) => b.name === branchName) ??
    branches.find((b) => b.name === sanitizeBranchName(branchName))

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
          withheldUsers: b.withheldAccess?.users,
          withheldGroups: b.withheldAccess?.groups,
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
        // Fail CLOSED (`?? true`): these flags are optional on the wire (see
        // BranchListItem's doc comment in api/branch.ts) so a version-skewed
        // server, or a branches-list fetch that returned partial/legacy data,
        // can omit them. `isProtected` gates `canDelete`/`isSystemBranch` in
        // BranchManager.tsx and `submitBlocked` gates `canSubmit` -- both real
        // mutating actions -- so "no answer" must render as "protected"/
        // "blocked", the same fail-closed direction as `writeBlocked` below
        // (see Editor.tsx's `branchContentLocked` for the full rationale, which
        // applies identically here).
        isProtected: b.isProtected ?? true,
        // NOT flipped to `?? true`: `readOnly` only selects WHICH lock banner
        // to show (base-branch read-only vs. status lock) once something is
        // already known to be locked via `writeBlocked`/`submitBlocked` --
        // it never gates a write by itself. Defaulting it true on missing data
        // would mislabel a status lock as a base-branch lock (wrong banner
        // copy), not under-lock anything, so `?? false` stays correct here.
        readOnly: b.readOnly ?? false,
        writeBlocked: b.writeBlocked ?? true,
        submitBlocked: b.submitBlocked ?? true,
      }
    })
  }, [branches, branchName, options.comments])

  // Explicit reload: always issues a fresh, independent fetch (raw call, not
  // SWR's `mutate()` revalidate path) so callers requesting a reload right
  // after mount aren't coalesced against the still-in-flight automatic load
  // -- then writes the result into the shared cache so useBranchesData's
  // bound hook (and anything else reading BRANCHES_KEY) picks it up.
  // Side effects (default-branch adoption, error/success notifications) are
  // driven by the effects above, which react to that same cache write.
  // Resolves to the fresh listing, or undefined when the fetch failed.
  const reloadBranches = async (): Promise<BranchesData | undefined> => {
    options.setBusy(true)
    try {
      const fresh = await fetchBranches(apiClient, { cache, mutate: globalMutate })
      await globalMutate(BRANCHES_KEY, fresh, { revalidate: false })
      return fresh
    } catch (err) {
      console.error(err)
      showBranchesLoadFailed(err instanceof Error ? err.message : 'Failed to load branches')
      return undefined
    } finally {
      options.setBusy(false)
    }
  }

  const loadBranches = async () => {
    await reloadBranches()
  }

  // The confirm dialogs' handlers run long after the render that opened them, so they read
  // these at confirm time rather than from that render's closure.
  const latest = useRef({ branchName, branches, branchesData })
  latest.current = { branchName, branches, branchesData }

  // A legacy deep link can carry the raw form of a listed name; the actions key, look up and
  // send the listed name, resolved the way `currentBranch` resolves it.
  const listedName = (name: string): string =>
    latest.current.branches.some((b) => b.name === name) ? name : sanitizeBranchName(name)

  const pullRequestOf = (name: string): BranchPullRequest => {
    const b = latest.current.branches.find((x) => x.name === name)
    return { pullRequestNumber: b?.pullRequestNumber, pullRequestState: b?.pullRequestState }
  }

  // Keys of the actions whose confirm is open or whose work is in flight.
  const actionsInFlight = useRef(new Set<string>())

  /**
   * Runs `run` unless the same action on the same branch already has its confirm open or its
   * work in flight; then this request opens nothing and resolves at once. Mantine closes only
   * the confirm that was confirmed, so a second one opened by a repeated click would stay up
   * after the action succeeded.
   */
  const singleFlight = async (
    action: 'submit' | 'withdraw' | 'request-changes' | 'delete',
    branch: string,
    run: () => Promise<void>,
  ): Promise<void> => {
    const key = JSON.stringify([action, branch])
    if (actionsInFlight.current.has(key)) return
    actionsInFlight.current.add(key)
    try {
      await run()
    } finally {
      actionsInFlight.current.delete(key)
    }
  }

  // A workflow action that got no answer may have gone through, so the list reloads to show
  // where the branch stands rather than inviting a blind retry.
  const showOutcomeUnknown = (action: string) => {
    notifications.hide(BRANCH_OUTCOME_UNKNOWN_TOAST_ID)
    notifications.show({
      id: BRANCH_OUTCOME_UNKNOWN_TOAST_ID,
      message: branchActionOutcomeUnknown(action),
      color: 'yellow',
      autoClose: false,
      withCloseButton: true,
    })
  }
  const reportActionFailure = async (err: unknown, fallback: string, action: string) => {
    if (isUnanswered(err)) {
      showOutcomeUnknown(action)
      await loadBranches()
      return
    }
    notifications.show({ message: err instanceof Error ? err.message : fallback, color: 'red' })
  }

  const handleSubmit = (requested: string) => {
    const branchNameToSubmit = listedName(requested)
    return singleFlight('submit', branchNameToSubmit, async () => {
      // Drafts belong to the open branch, so only its submit can leave edits behind. Without
      // that check the dialog opens in this same tick.
      const checking =
        branchNameToSubmit === latest.current.branchName
          ? options.getUnsaved?.().catch((err: unknown) => {
              console.error(err)
              return undefined
            })
          : undefined
      const unsaved = checking && (await checking)
      return new Promise<void>((resolve, reject) => {
        showSubmitConfirmation(
          branchNameToSubmit,
          unsaved,
          async () => {
            // A listing that arrived while the dialog was open may show the branch already
            // submitted; submitting it again would only fail.
            const listed = latest.current.branches.find((b) => b.name === branchNameToSubmit)
            if (listed?.status === 'submitted') {
              notifications.show({
                message: 'Branch is already submitted for review',
                color: 'blue',
              })
              resolve()
              return
            }
            options.setBusy(true)
            try {
              const result = await apiClient.workflow.submit({
                branch: branchNameToSubmit,
              })
              if (!result.ok) throw actionError(result, 'Failed to submit branch')
              notifications.show({
                message: 'Branch submitted for review',
                color: 'green',
              })
              updateCreatedBranch(branchNameToSubmit, result.data?.branch)
              await loadBranches()
              resolve()
            } catch (err) {
              await reportActionFailure(
                err,
                'Failed to submit branch',
                EDITOR_ACTIONS.submitForReview,
              )
              reject(err)
            } finally {
              options.setBusy(false)
            }
          },
          // Dismissal is not an error: the call sites log rejections to the console. Settled
          // once, by onCancel OR onClose, so an Escape/overlay dismissal can't leave this pending.
          () => resolve(),
        )
      })
    })
  }

  const handleWithdraw = (requested: string) => {
    const branchNameToWithdraw = listedName(requested)
    return singleFlight(
      'withdraw',
      branchNameToWithdraw,
      () =>
        new Promise<void>((resolve, reject) => {
          showWithdrawConfirmation(
            branchNameToWithdraw,
            pullRequestOf(branchNameToWithdraw),
            async () => {
              options.setBusy(true)
              try {
                const result = await apiClient.workflow.withdraw({
                  branch: branchNameToWithdraw,
                })
                if (!result.ok) throw actionError(result, 'Failed to withdraw branch')
                notifications.show({ message: 'Branch withdrawn', color: 'blue' })
                updateCreatedBranch(branchNameToWithdraw, result.data?.branch)
                await loadBranches()
                resolve()
              } catch (err) {
                await reportActionFailure(
                  err,
                  'Failed to withdraw branch',
                  EDITOR_ACTIONS.withdrawFromReview,
                )
                reject(err)
              } finally {
                options.setBusy(false)
              }
            },
            () => resolve(),
          )
        }),
    )
  }

  const handleRequestChanges = (branchNameForChanges: string) =>
    singleFlight(
      'request-changes',
      branchNameForChanges,
      () =>
        new Promise<void>((resolve) => {
          showRequestChangesConfirmation(
            branchNameForChanges,
            async () => {
              options.setBusy(true)
              try {
                const result = await apiClient.workflow.requestChanges({
                  branch: branchNameForChanges,
                })
                if (!result.ok) throw actionError(result, 'Failed to request changes')
                notifications.show({ message: 'Changes requested', color: 'blue' })
                updateCreatedBranch(branchNameForChanges, result.data?.branch)
                await loadBranches()
              } catch (err) {
                await reportActionFailure(
                  err,
                  'Failed to request changes',
                  EDITOR_ACTIONS.requestChanges,
                )
              } finally {
                options.setBusy(false)
                resolve()
              }
            },
            () => resolve(),
          )
        }),
    )

  /** After a delete: drop it from the created-branch overlay, and leave it if it is open. */
  const leaveDeletedBranch = (deleted: string, fresh: BranchesData | undefined) => {
    forgetCreatedBranch(deleted)
    // Matched the way `currentBranch` resolves a name, since the deleted branch is no longer
    // listed to resolve against.
    const open = latest.current.branchName
    if (open === deleted || sanitizeBranchName(open) === deleted) {
      // Nothing is left to keep, so no unsaved-changes prompt. With no default known yet, the
      // empty name lets the default-branch adoption effect pick it.
      setBranchName(fresh?.defaultBranch ?? latest.current.branchesData?.defaultBranch ?? '')
    }
  }

  const handleDelete = (requested: string) => {
    const branchNameToDelete = listedName(requested)
    return singleFlight(
      'delete',
      branchNameToDelete,
      () =>
        new Promise<void>((resolve) => {
          showDeleteConfirmation(
            branchNameToDelete,
            pullRequestOf(branchNameToDelete),
            async () => {
              options.setBusy(true)
              try {
                const result = await apiClient.branches.delete({
                  branch: branchNameToDelete,
                })
                // The API's own 404: the branch is already gone, by an earlier unanswered delete or
                // another user's.
                if (!result.ok && result.status === 404 && !isNonApiResponse(result)) {
                  notifications.show({ message: 'Branch deleted', color: 'green' })
                  leaveDeletedBranch(branchNameToDelete, await reloadBranches())
                  return
                }
                if (!result.ok) throw actionError(result, 'Failed to delete branch')
                const cleanupWarning = result.data?.cleanupWarning
                notifications.show(
                  cleanupWarning
                    ? {
                        message: `Branch deleted, with a warning: ${cleanupWarning}`,
                        color: 'yellow',
                        autoClose: false,
                      }
                    : { message: 'Branch deleted', color: 'green' },
                )
                leaveDeletedBranch(branchNameToDelete, await reloadBranches())
              } catch (err) {
                if (!isUnanswered(err)) {
                  await reportActionFailure(err, 'Failed to delete branch', 'Delete branch')
                  return
                }
                // Settled by the list: unlisted, and not created too recently to be listed, means deleted.
                const fresh = await reloadBranches()
                const recent = pendingBranches.filter(
                  (p) => Date.now() - p.addedAt <= CREATED_BRANCH_GRACE_MS,
                )
                const listed = mergePendingBranches(fresh?.branches ?? [], recent).some(
                  (b) => sanitizeBranchName(b.name) === sanitizeBranchName(branchNameToDelete),
                )
                if (fresh && !listed) {
                  notifications.show({ message: 'Branch deleted', color: 'green' })
                  leaveDeletedBranch(branchNameToDelete, fresh)
                } else {
                  showOutcomeUnknown('Delete branch')
                }
              } finally {
                options.setBusy(false)
                // Failures surface as the toast above, never as a rejection; cancelling resolves too.
                resolve()
              }
            },
            () => resolve(),
          )
        }),
    )
  }

  const handleReloadBranchData = async () => {
    await loadBranches()
  }

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
    addCreatedBranch,
    handleSubmit,
    handleWithdraw,
    handleRequestChanges,
    handleDelete,
    handleReloadBranchData,
    loadBranches,
  }
}
