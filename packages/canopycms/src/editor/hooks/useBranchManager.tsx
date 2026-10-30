'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import { Alert, Stack, Text } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'
import { openConfirm } from '../utils/confirm-modal'
import { focusReturnProps } from '../utils/focus-return'
import { EDITOR_ACTIONS } from '../copy'
import { notifications } from '@mantine/notifications'
import type { BranchHold, ConflictStatus, PullRequestState, SyncStatus } from '../../types'
import type { OperatingMode } from '../../operating-mode'
import type { CommentThread } from '../../comment-store'
import type { BranchListItem } from '../../api/branch'
import { useApiClient, useBranchSegments } from '../context'
import { BRANCHES_KEY, fetchBranches, useBranchesData, type BranchesData } from './useBranchesData'
// branch-name, NOT branch or the '../../paths' barrel: both of those pull
// node:fs/promises + node:path at the top level (path RESOLUTION helpers),
// which breaks adopters' production `next build` of the editor bundle.
// paths/branch-name.ts is the dependency-free home of sanitizeBranchName.
import { sanitizeBranchName } from '../../paths/branch-name'
import { exactBranchName, exactBranchSegment } from '../../paths/validation'
import {
  branchAddress,
  branchUrlName,
  displayBranchName,
  requestSegments,
  unlistedSegment,
  resolveListedBranch,
} from '../branch-names'
import { RetryToastMessage } from '../components/RetryToastMessage'
import { isNonApiResponse } from '../../api/client'
import { isGatewayFailure, isUnanswered, UnansweredError } from '../unanswered'
import type { ApiResponse } from '../../api/types'
import type { UnsavedSummary } from './useDraftManager'
import type { StampedEntry } from '../../stamp-on-publish'
import { describeUnsaved } from './useBranchActions'
import { writeEditorUrl } from './editor-history'
import {
  approveMessage,
  NoteNotSavedMessage,
  RequestChangesForm,
} from '../components/ReviewDialogs'

const BRANCHES_LOAD_FAILED_TOAST_ID = 'canopy-branches-load-failed'
const BRANCH_OUTCOME_UNKNOWN_TOAST_ID = 'canopy-branch-outcome-unknown'

/** The API's 409: the branch is no longer in the state the action needs, so a retry cannot pass. */
class StaleStatusError extends Error {
  override readonly name = 'StaleStatusError'
}

/** An answer that refused the action, with its HTTP status: a 4xx is a refusal no retry passes. */
class RefusedError extends Error {
  override readonly name = 'RefusedError'
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/**
 * The error a refused branch action throws; a gateway's 5xx says nothing of whether it ran.
 * With `staleIsConflict`, the API's 409 is a `StaleStatusError`.
 */
function actionError(result: ApiResponse, fallback: string, staleIsConflict = false): Error {
  if (isGatewayFailure(result)) return new UnansweredError()
  const message = result.error || fallback
  if (result.ok) return new Error(message)
  return staleIsConflict && result.status === 409 && !isNonApiResponse(result)
    ? new StaleStatusError(message)
    : new RefusedError(message, result.status)
}

type ReviewKind = 'approve' | 'request-changes'

/** Whether a branch's status still lets the reviewer act: Approve needs submitted. */
const acceptsReview = (status: string | undefined, kind: ReviewKind): boolean =>
  kind === 'approve' ? status === 'submitted' : status === 'submitted' || status === 'approved'

/** The line for a branch the reviewer's page still showed in review after it left. */
const leftReviewMessage = (status: string, kind: ReviewKind): string =>
  status === 'editing'
    ? "This branch is no longer in review: it's back with its editor."
    : status === 'approved' && kind === 'approve'
      ? 'This branch is already approved.'
      : `This branch is ${status}, so ${kind === 'approve' ? "it can't be approved" : "changes can't be requested"}.`

/** @internal Exported for tests. */
export const branchActionOutcomeUnknown = (
  action: string,
  check = "Check the branch's status before trying again.",
) => `${action} may have gone through even though the server didn't answer. ${check}`

/** Where to look after a Request changes nobody answered: the status, and the note it carried. */
const REQUEST_CHANGES_CHECK = `Check the branch's status and its comments in "Comments".`

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
const submittedMessage = (stampedCount: number): string =>
  stampedCount === 0
    ? 'Branch submitted for review'
    : `Branch submitted for review. Dates set on ${stampedCount} new ${stampedCount === 1 ? 'entry' : 'entries'}.`

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
 * is saved, and the branch is read-only in review, so they wait as drafts until it is editable.
 */
const showSubmitConfirmation = (
  branchName: string,
  unsaved: UnsavedSummary | undefined,
  onConfirm: () => Promise<void>,
  onDismiss: () => void,
  returnFocusTo?: () => HTMLElement | null,
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
            {describeUnsaved(leftOut)} To include them, cancel and save first. If you submit now,
            those changes stay unsaved on this branch while it is in review.
          </Alert>
        )}
        <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
          {`Submit “${branchName}” for review?\n\nThis will:\n• Create a pull request for review\n• Change the branch status to “In review”\n• Notify reviewers of pending changes`}
        </Text>
      </Stack>
    ),
    labels: {
      confirm: leftOut ? 'Submit anyway' : EDITOR_ACTIONS.submitForReview,
      cancel: 'Cancel',
    },
    confirmProps: { color: 'brand', 'data-testid': 'confirm-submit-branch' },
    ...confirmModalHandlers(onConfirm, onDismiss),
    ...focusReturnProps(returnFocusTo),
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
  returnFocusTo?: () => HTMLElement | null,
) => {
  const bullets = [
    withdrawPullRequestBullet(pr),
    'Change the branch status back to “editing”',
    'Remove from review queue',
  ].filter((b): b is string => b !== undefined)
  openConfirm({
    title: EDITOR_ACTIONS.withdrawFromReview,
    children: (
      <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
        {`Withdraw “${branchName}” from review?\n\nThis will:\n${bullets.map((b) => `• ${b}`).join('\n')}`}
      </Text>
    ),
    labels: { confirm: EDITOR_ACTIONS.withdrawFromReview, cancel: 'Cancel' },
    confirmProps: { color: 'orange', 'data-testid': 'confirm-withdraw-branch' },
    ...confirmModalHandlers(onConfirm, onDismiss),
    ...focusReturnProps(returnFocusTo),
  })
}

const showApproveConfirmation = (
  branchName: string,
  pr: BranchPullRequest,
  onConfirm: () => Promise<void>,
  onDismiss: () => void,
  returnFocusTo?: () => HTMLElement | null,
) => {
  openConfirm({
    title: EDITOR_ACTIONS.approve,
    children: <Text size="sm">{approveMessage(branchName, !!pr.pullRequestNumber)}</Text>,
    labels: { confirm: EDITOR_ACTIONS.approve, cancel: 'Cancel' },
    confirmProps: { color: 'brand', 'data-testid': 'confirm-approve-branch' },
    ...confirmModalHandlers(onConfirm, onDismiss),
    ...focusReturnProps(returnFocusTo),
  })
}

/**
 * `onConfirm` receives the note as typed, which the dialog starts with `initialNote` and reports
 * through `onNoteChange` as it changes, so a draft outlives the dialog.
 */
const showRequestChangesConfirmation = (
  branchName: string,
  pr: BranchPullRequest,
  initialNote: string,
  onNoteChange: (note: string) => void,
  onConfirm: (note: string) => Promise<void>,
  onDismiss: () => void,
  returnFocusTo?: () => HTMLElement | null,
) => {
  let note = initialNote
  openConfirm({
    title: EDITOR_ACTIONS.requestChanges,
    children: (
      <RequestChangesForm
        branchName={branchName}
        hasPullRequest={!!pr.pullRequestNumber}
        initialNote={initialNote}
        onNoteChange={(value) => {
          note = value
          onNoteChange(value)
        }}
      />
    ),
    labels: { confirm: EDITOR_ACTIONS.requestChanges, cancel: 'Cancel' },
    confirmProps: { color: 'red', 'data-testid': 'confirm-request-changes' },
    ...confirmModalHandlers(() => onConfirm(note), onDismiss),
    ...focusReturnProps(returnFocusTo),
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
        {`Delete “${branchName}”?\n\nThis will:\n${bullets.map((b) => `• ${b}`).join('\n')}\n\nThis cannot be undone.`}
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
 * What a request sends for `name`, a full name the listing no longer holds: the exact form when a
 * listed short name is `name`, which would open that namespace branch instead, else as unlisted.
 */
function unlistedName(listed: readonly BranchListItem[], name: string): string {
  return listed.some((b) => b.name !== name && displayBranchName(b) === name)
    ? exactBranchSegment(name)
    : unlistedSegment(name)
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
  shortName?: string
  status: string
  createdBy?: string
  updatedAt?: string
  access: {
    users: string[] | undefined
    groups: string[] | undefined
    managerOrAdminAllowed: boolean | undefined
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
  /** What is stuck and needs a person (api/branch.ts). */
  hold?: BranchHold
  commentCount: number
  isProtected: boolean
  readOnly: boolean
  /**
   * Server-computed: content writes are rejected, because the branch is the
   * read-only base branch OR its status is past 'editing'. `readOnly` still
   * says WHICH, for the status copy.
   */
  writeBlocked: boolean
  /**
   * Server-computed compound submit rule: true when the branch can never be
   * submitted for review, for ANY reason -- it is the protected base
   * branch, its workflow status has moved past 'editing', or it was rewritten
   * on GitHub (`toBranchListItem`). Mirrors
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

  /** The entries a submit of the open branch stamped (useDraftManager's `applySubmitStamps`). */
  onStamped?: (stamped: StampedEntry[]) => void

  /** A request for changes went through; the branch may now carry the reviewer's note as a comment. */
  onChangesRequested?: (branchName: string) => void
}

export interface UseBranchManagerReturn {
  /**
   * The listed full name of the open branch, which keys everything stored or fetched per branch.
   * Until a listing resolves the name it arrived by, that name as given.
   */
  branchName: string
  /** Opens the branch `name` names, a URL value or card address, resolved once a listing holds it. */
  setBranchName: (name: string) => void
  branches: BranchListItem[]
  branchSummaries: BranchSummary[]
  currentBranch: BranchListItem | undefined
  /** What the open branch's own actions hand `handleSubmit` and the rest (`branchAddress`). */
  currentAddress: string
  /** The listed branch `name`, a URL value or card address, opens. */
  listedBranch: (name: string) => BranchListItem | undefined
  /** The full name of the listed branch `name` opens, else `name` sanitized. */
  listedName: (name: string) => string
  /** Whether `name`, a URL value or card address, opens `branch`, a `branchName` this gave. */
  namesBranch: (name: string, branch: string) => boolean
  /** What `?branch=` carries for the branch `name`, a full name or its exact form, names, else `name`. */
  urlBranchName: (name: string) => string
  /** The listing failed and nothing earlier stands in for it. */
  branchesLoadFailed: boolean
  /** A listing has arrived, so a branch missing from it is not still loading. */
  branchesLoaded: boolean
  /** Shows a branch the server just created before any listing includes it. */
  addCreatedBranch: (branch: BranchListItem) => void
  /** Confirms first; the dialog returns focus to `returnFocusTo()` when given, else its opener. */
  handleSubmit: (branchName: string, returnFocusTo?: () => HTMLElement | null) => Promise<void>
  /** Confirms first; the dialog returns focus to `returnFocusTo()` when given, else its opener. */
  handleWithdraw: (branchName: string, returnFocusTo?: () => HTMLElement | null) => Promise<void>
  /** Confirms first; the dialog returns focus to `returnFocusTo()` when given, else its opener. */
  handleApprove: (branchName: string, returnFocusTo?: () => HTMLElement | null) => Promise<void>
  /** Confirms first, taking an optional note; focus returns as for `handleApprove`. */
  handleRequestChanges: (
    branchName: string,
    returnFocusTo?: () => HTMLElement | null,
  ) => Promise<void>
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
  // The open branch. Once `exact`, `name` is the listed branch's full name, matched only by that
  // name: a listing that changes which branch a short name opens never moves it. Until then
  // `name` is what a URL, link, history entry or card gave, which `resolveListedBranch` resolves
  // once a listing holds it.
  const [open, setOpen] = useState({ name: options.initialBranch, exact: false })
  const setBranchName = useCallback((name: string) => setOpen({ name, exact: false }), [])
  const openExactly = useCallback((name: string) => setOpen({ name, exact: true }), [])
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

  const arriving = open.exact ? undefined : resolveListedBranch(branches, open.name)
  const branchName = arriving?.name ?? open.name
  const resolved = open.exact || !!arriving
  const currentBranch = open.exact ? branches.find((b) => b.name === open.name) : arriving
  const currentBranchName = currentBranch?.name

  // A listed branch by `requestSegments`; the open branch, once the listing drops it, as
  // `unlistedName` does; any other name by the client's own lookup (`unlistedSegment`).
  const segments = useMemo(() => {
    const table = requestSegments(branches)
    if (resolved && branchName && !table.has(branchName)) {
      table.set(branchName, unlistedName(branches, branchName))
    }
    return table
  }, [branches, resolved, branchName])
  useBranchSegments(segments)

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
    if (!branchName && branchesData?.defaultBranch) openExactly(branchesData.defaultBranch)
  }, [branchesData, branchName, openExactly])

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

  // Resolved once, as it arrives: from here the full name is the branch, and drafts, comments and
  // everything else keyed per branch see one name for it.
  useEffect(() => {
    if (!open.exact && arriving) openExactly(arriving.name)
  }, [open, arriving, openExactly])

  const branchSummaries = useMemo(() => {
    return branches.map((b) => {
      const branchComments = b.name === currentBranchName ? options.comments : []
      const unresolvedCount = branchComments.filter((t) => !t.resolved).length
      return {
        name: b.name,
        shortName: b.shortName,
        status: b.status,
        createdBy: b.createdBy,
        updatedAt: b.updatedAt,
        access: {
          users: b.access.allowedUsers,
          groups: b.access.allowedGroups,
          managerOrAdminAllowed: b.access.managerOrAdminAllowed,
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
        hold: b.hold,
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
        // NOT flipped to `?? true`: `readOnly` only selects WHICH lock the status
        // names (base-branch read-only vs. status lock) once something is
        // already known to be locked via `writeBlocked`/`submitBlocked` --
        // it never gates a write by itself. Defaulting it true on missing data
        // would mislabel a status lock as a base-branch lock (wrong status
        // copy), not under-lock anything, so `?? false` stays correct here.
        readOnly: b.readOnly ?? false,
        writeBlocked: b.writeBlocked ?? true,
        submitBlocked: b.submitBlocked ?? true,
      }
    })
  }, [branches, currentBranchName, options.comments])

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
  const latest = useRef({ branchName, resolved, branches, branchesData })
  latest.current = { branchName, resolved, branches, branchesData }

  // A card, deep link or URL can carry a short name, an exact form or the raw form of a listed
  // name; the actions resolve it once, the way an arriving name resolves, then key, look up and
  // send the listed name.
  const listedBranch = (name: string): BranchListItem | undefined =>
    resolveListedBranch(latest.current.branches, name)
  const listedName = (name: string): string => listedBranch(name)?.name ?? sanitizeBranchName(name)

  // What an action sends for `name`, resolved when it was asked for: the listing can drop the
  // branch while its dialog is open.
  const sendName = (name: string): string => {
    const listed = latest.current.branches
    return listed.some((b) => b.name === name) ? name : unlistedName(listed, name)
  }

  // The listed name of the open branch: the state itself once resolved.
  const openListedName = (): string =>
    latest.current.resolved ? latest.current.branchName : listedName(latest.current.branchName)

  const namesBranch = (name: string, branch: string): boolean => {
    const found = listedBranch(name)
    return found ? found.name === branch : sanitizeBranchName(name) === sanitizeBranchName(branch)
  }

  // What a dialog or toast calls the listed branch `name`; the keys, lookups and requests keep `name`.
  const shownName = (name: string): string => {
    const found = latest.current.branches.find((b) => b.name === name)
    return found ? displayBranchName(found) : name
  }

  // The `?branch=` value for `name`, a full name or a card's address: the URL form of the branch
  // listed by that full name, else `name` as given.
  const urlBranchName = (name: string): string => {
    const listed = latest.current.branches
    const full = exactBranchName(name) ?? name
    const found = listed.find((b) => b.name === full)
    return found ? branchUrlName(listed, found) : name
  }

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
    action: 'submit' | 'withdraw' | 'approve' | 'request-changes' | 'delete',
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
  const showOutcomeUnknown = (action: string, check?: string) => {
    notifications.hide(BRANCH_OUTCOME_UNKNOWN_TOAST_ID)
    notifications.show({
      id: BRANCH_OUTCOME_UNKNOWN_TOAST_ID,
      message: branchActionOutcomeUnknown(action, check),
      color: 'yellow',
      autoClose: false,
      withCloseButton: true,
    })
  }
  const reportActionFailure = async (
    err: unknown,
    fallback: string,
    action: string,
    follow: {
      /** Where to look after an unanswered write, in place of the branch's status alone. */
      check?: string
      /** Runs once an unanswered write's branch list has reloaded, with that listing. */
      afterUnanswered?: (fresh: BranchesData | undefined) => void
    } = {},
  ) => {
    if (isUnanswered(err)) {
      showOutcomeUnknown(action, follow.check)
      const fresh = await reloadBranches()
      follow.afterUnanswered?.(fresh)
      return
    }
    notifications.show({ message: err instanceof Error ? err.message : fallback, color: 'red' })
  }

  // A note typed in the Request changes dialog, by branch, until a request carries it or the
  // branch leaves review.
  const noteDrafts = useRef(new Map<string, string>())

  // The stale-status toasts that carry a note and stay up, by id: a plain one never replaces them.
  const stickyStaleToasts = useRef(new Set<string>())

  /**
   * A review action found its branch out of review, or the page already knew it was. A warning,
   * not an error: nothing is lost yet. A typed note is shown to copy, so it stays up until
   * dismissed, and a later toast without a note leaves it be. The note's draft is the caller's to
   * judge: Request changes still takes a branch that is merely approved.
   */
  const showLeftReview = (branch: string, message: string, note: string | undefined) => {
    const id = `canopy-review-stale-${branch}`
    if (!note && stickyStaleToasts.current.has(id)) return
    notifications.hide(id)
    stickyStaleToasts.current.delete(id)
    if (note) stickyStaleToasts.current.add(id)
    notifications.show({
      id,
      message: note ? (
        <NoteNotSavedMessage message={message} note={note} hint="Copy it to keep it." />
      ) : (
        message
      ),
      color: 'yellow',
      withCloseButton: true,
      ...(note ? { autoClose: false, onClose: () => stickyStaleToasts.current.delete(id) } : {}),
    })
  }

  /** Forgets a branch's draft when the listing shows it out of review. */
  const dropDraftsOutOfReview = (branches: readonly { name: string; status: string }[]) => {
    for (const { name, status } of branches) {
      if (!acceptsReview(status, 'request-changes')) noteDrafts.current.delete(name)
    }
  }

  const reviewFailureId = (kind: ReviewKind, branch: string) => `canopy-${kind}-failed-${branch}`

  /**
   * Why an Approve or Request changes failed. Retry only on an API 5xx, 408, 429 or unsent request;
   * a timeout or gateway 5xx may have landed, so it reloads and says what to check. Other 4xx: a
   * plain message and a reload. A 409 means the branch left review (see `showLeftReview`).
   */
  const reportReviewFailure = async (
    err: unknown,
    kind: ReviewKind,
    branch: string,
    details: {
      fallback: string
      label: string
      /** The reviewer's note as sent, which a 409 shows back to copy. */
      note?: string
      /** Reopens the action's dialog. */
      retry: () => void
      check?: string
      afterUnanswered?: (fresh: BranchesData | undefined) => void
    },
  ) => {
    if (err instanceof StaleStatusError) {
      showLeftReview(branch, err.message, details.note)
      // What the branch is now decides whether a Request changes note is still wanted.
      const fresh = await reloadBranches()
      if (fresh) dropDraftsOutOfReview(fresh.branches)
      return
    }
    if (isUnanswered(err)) {
      await reportActionFailure(err, details.fallback, details.label, details)
      return
    }
    const message = err instanceof Error ? err.message : details.fallback
    const id = reviewFailureId(kind, branch)
    notifications.hide(id)
    // A 4xx is a refusal no retry passes, except for asking again later (408, 429).
    if (
      err instanceof RefusedError &&
      err.status < 500 &&
      err.status !== 408 &&
      err.status !== 429
    ) {
      notifications.show({
        id,
        message: details.note ? (
          <NoteNotSavedMessage message={message} note={details.note} hint="Copy it to keep it." />
        ) : (
          message
        ),
        color: 'red',
        ...(details.note ? { autoClose: false } : {}),
      })
      await loadBranches()
      return
    }
    notifications.show({
      id,
      message: (
        <RetryToastMessage
          message={message}
          onRetry={() => {
            notifications.hide(id)
            void (async () => {
              // The page may be stale by now: a branch that left review has nothing to retry.
              // The listing is fetched first, so the decision is made on where the branch is now.
              const fresh = await reloadBranches()
              const status = (fresh?.branches ?? latest.current.branches).find(
                (b) => b.name === branch,
              )?.status
              if (status !== undefined && !acceptsReview(status, kind)) {
                showLeftReview(
                  branch,
                  leftReviewMessage(status, kind),
                  noteDrafts.current.get(branch),
                )
                // An approved branch still takes Request changes, so its draft stays.
                if (!acceptsReview(status, 'request-changes')) noteDrafts.current.delete(branch)
                return
              }
              details.retry()
            })()
          }}
        />
      ),
      color: 'red',
      autoClose: false,
    })
  }

  const handleSubmit = (requested: string, returnFocusTo?: () => HTMLElement | null) => {
    const branchNameToSubmit = listedName(requested)
    return singleFlight('submit', branchNameToSubmit, async () => {
      // Drafts belong to the open branch, so only its submit can leave edits behind. Without
      // that check the dialog opens in this same tick.
      const checking =
        branchNameToSubmit === openListedName()
          ? options.getUnsaved?.().catch((err: unknown) => {
              console.error(err)
              return undefined
            })
          : undefined
      // Checking can wait on draft verification, so the busy state shows it is working meanwhile.
      if (checking) options.setBusy(true)
      const unsaved = checking && (await checking.finally(() => options.setBusy(false)))
      return new Promise<void>((resolve, reject) => {
        showSubmitConfirmation(
          shownName(branchNameToSubmit),
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
              const result = await apiClient.workflow.submit(
                { branch: sendName(branchNameToSubmit) },
                // The PR body links back here; the server checks the host (editor-url.ts).
                { editorUrl: `${window.location.origin}${window.location.pathname}` },
              )
              if (!result.ok) throw actionError(result, 'Failed to submit branch')
              const stamped = result.data?.stamped
              if (stamped && branchNameToSubmit === openListedName()) {
                options.onStamped?.(stamped)
              }
              notifications.show({
                message: submittedMessage(stamped?.length ?? 0),
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
          returnFocusTo,
        )
      })
    })
  }

  const handleWithdraw = (requested: string, returnFocusTo?: () => HTMLElement | null) => {
    const branchNameToWithdraw = listedName(requested)
    return singleFlight(
      'withdraw',
      branchNameToWithdraw,
      () =>
        new Promise<void>((resolve, reject) => {
          showWithdrawConfirmation(
            shownName(branchNameToWithdraw),
            pullRequestOf(branchNameToWithdraw),
            async () => {
              options.setBusy(true)
              try {
                const result = await apiClient.workflow.withdraw({
                  branch: sendName(branchNameToWithdraw),
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
            returnFocusTo,
          )
        }),
    )
  }

  const handleApprove = (requested: string, returnFocusTo?: () => HTMLElement | null) => {
    const branchNameToApprove = listedName(requested)
    return singleFlight(
      'approve',
      branchNameToApprove,
      () =>
        new Promise<void>((resolve, reject) => {
          showApproveConfirmation(
            shownName(branchNameToApprove),
            pullRequestOf(branchNameToApprove),
            async () => {
              options.setBusy(true)
              try {
                const result = await apiClient.workflow.approve({
                  branch: sendName(branchNameToApprove),
                })
                if (!result.ok) throw actionError(result, 'Failed to approve branch', true)
                notifications.hide(reviewFailureId('approve', branchNameToApprove))
                notifications.show({ message: 'Branch approved', color: 'green' })
                updateCreatedBranch(branchNameToApprove, result.data?.branch)
                await loadBranches()
                resolve()
              } catch (err) {
                await reportReviewFailure(err, 'approve', branchNameToApprove, {
                  fallback: 'Failed to approve branch',
                  label: `${EDITOR_ACTIONS.approve} “${shownName(branchNameToApprove)}”`,
                  retry: () =>
                    void handleApprove(branchNameToApprove, returnFocusTo).catch(() => {}),
                })
                reject(err)
              } finally {
                options.setBusy(false)
              }
            },
            () => resolve(),
            returnFocusTo,
          )
        }),
    )
  }

  const handleRequestChanges = (requested: string, returnFocusTo?: () => HTMLElement | null) => {
    const branchNameForChanges = listedName(requested)
    // A draft is for the review cycle it was typed in; a branch already out of review starts clean.
    dropDraftsOutOfReview(latest.current.branches.filter((b) => b.name === branchNameForChanges))
    return singleFlight(
      'request-changes',
      branchNameForChanges,
      () =>
        new Promise<void>((resolve) => {
          showRequestChangesConfirmation(
            shownName(branchNameForChanges),
            pullRequestOf(branchNameForChanges),
            noteDrafts.current.get(branchNameForChanges) ?? '',
            (draft) => {
              if (draft) noteDrafts.current.set(branchNameForChanges, draft)
              else noteDrafts.current.delete(branchNameForChanges)
            },
            async (note) => {
              options.setBusy(true)
              try {
                const result = await apiClient.workflow.requestChanges(
                  { branch: sendName(branchNameForChanges) },
                  { note: note.trim() || undefined },
                )
                if (!result.ok) throw actionError(result, 'Failed to request changes', true)
                noteDrafts.current.delete(branchNameForChanges)
                notifications.hide(reviewFailureId('request-changes', branchNameForChanges))
                notifications.show({ message: 'Changes requested', color: 'blue' })
                // The note is saved apart from the status change, so it can fail on its own;
                // the warning stays up, with the note to copy, because the words are not saved.
                const warning = result.data?.warning
                if (warning) {
                  notifications.show({
                    message: <NoteNotSavedMessage message={warning} note={note.trim()} />,
                    color: 'yellow',
                    autoClose: false,
                    withCloseButton: true,
                  })
                }
                updateCreatedBranch(branchNameForChanges, result.data?.branch)
                await loadBranches()
                options.onChangesRequested?.(branchNameForChanges)
              } catch (err) {
                await reportReviewFailure(err, 'request-changes', branchNameForChanges, {
                  fallback: 'Failed to request changes',
                  label: `${EDITOR_ACTIONS.requestChanges} on “${shownName(branchNameForChanges)}”`,
                  note: note.trim() || undefined,
                  retry: () =>
                    void handleRequestChanges(branchNameForChanges, returnFocusTo).catch(() => {}),
                  check: REQUEST_CHANGES_CHECK,
                  afterUnanswered: (fresh) => {
                    // The write may have landed along with its note.
                    options.onChangesRequested?.(branchNameForChanges)
                    if (fresh) dropDraftsOutOfReview(fresh.branches)
                  },
                })
              } finally {
                options.setBusy(false)
                resolve()
              }
            },
            () => resolve(),
            returnFocusTo,
          )
        }),
    )
  }

  /**
   * After a delete: drop it from the created-branch overlay, and leave it if it is open. A name
   * still unresolved is resolved against the listing from before the delete (`listedBefore`),
   * since the deleted branch is no longer listed to resolve against.
   */
  const leaveDeletedBranch = (
    deleted: string,
    listedBefore: readonly BranchListItem[],
    fresh: BranchesData | undefined,
  ) => {
    forgetCreatedBranch(deleted)
    const { branchName: openName, resolved: openResolved } = latest.current
    const openListed = openResolved
      ? openName
      : (resolveListedBranch(listedBefore, openName)?.name ?? sanitizeBranchName(openName))
    if (openListed === deleted) {
      // Nothing is left to keep, so no unsaved-changes prompt. With no default known yet, the
      // empty name lets the default-branch adoption effect pick it.
      openExactly(fresh?.defaultBranch ?? latest.current.branchesData?.defaultBranch ?? '')
    }
  }

  const handleDelete = (requested: string) => {
    const branchNameToDelete = listedName(requested)
    const listedBefore = latest.current.branches
    return singleFlight(
      'delete',
      branchNameToDelete,
      () =>
        new Promise<void>((resolve) => {
          showDeleteConfirmation(
            shownName(branchNameToDelete),
            pullRequestOf(branchNameToDelete),
            async () => {
              options.setBusy(true)
              try {
                const result = await apiClient.branches.delete({
                  branch: sendName(branchNameToDelete),
                })
                // The API's own 404: the branch is already gone, by an earlier unanswered delete or
                // another user's.
                if (!result.ok && result.status === 404 && !isNonApiResponse(result)) {
                  notifications.show({ message: 'Branch deleted', color: 'green' })
                  leaveDeletedBranch(branchNameToDelete, listedBefore, await reloadBranches())
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
                leaveDeletedBranch(branchNameToDelete, listedBefore, await reloadBranches())
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
                  leaveDeletedBranch(branchNameToDelete, listedBefore, fresh)
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

  // The editor's own page; a Back off it to a page of the host leaves that page's URL alone.
  const editorPathRef = useRef(typeof window === 'undefined' ? '' : window.location.pathname)
  const shownBranch = currentBranch ? branchUrlName(branches, currentBranch) : undefined
  // Each Back or Forward, which can arrive at an entry naming this branch in another form.
  const [historyMoves, setHistoryMoves] = useState(0)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const moved = () => setHistoryMoves((n) => n + 1)
    window.addEventListener('popstate', moved)
    return () => window.removeEventListener('popstate', moved)
  }, [])
  const seenMovesRef = useRef(historyMoves)
  // Written once the listing resolves the branch, so a link's own form stays until then; a form
  // other than the shown one (the full name, a raw name) is replaced, never pushed. After a Back
  // or Forward only a form of this branch is: one naming another is the entry manager's switch.
  useEffect(() => {
    const popped = seenMovesRef.current !== historyMoves
    seenMovesRef.current = historyMoves
    if (typeof window === 'undefined') return
    if (!shownBranch || window.location.pathname !== editorPathRef.current) return
    const url = new URL(window.location.href)
    const named = url.searchParams.get('branch')
    if (named === shownBranch) return
    if (popped && named !== null && listedBranch(named)?.name !== latest.current.branchName) return
    url.searchParams.set('branch', shownBranch)
    writeEditorUrl(url.toString(), false)
  }, [shownBranch, historyMoves])

  return {
    branchName,
    setBranchName,
    branches,
    branchSummaries,
    currentBranch,
    currentAddress: currentBranch ? branchAddress(branches, currentBranch) : branchName,
    listedBranch,
    listedName,
    namesBranch,
    urlBranchName,
    branchesLoadFailed: !!branchesError && !branchesData,
    branchesLoaded: !!branchesData,
    addCreatedBranch,
    handleSubmit,
    handleWithdraw,
    handleApprove,
    handleRequestChanges,
    handleDelete,
    handleReloadBranchData,
    loadBranches,
  }
}
