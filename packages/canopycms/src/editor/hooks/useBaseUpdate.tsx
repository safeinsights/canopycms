'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import { notifications } from '@mantine/notifications'
import type { BranchListItem } from '../../api/branch'
import type { LastBaseUpdate } from '../../types'
import type { OperatingMode } from '../../operating-mode/types'
import { clientOperatingStrategy } from '../../operating-mode/client'
import { isBaseUpdatePending } from '../../base-update'
import { useApiClient } from '../context'
import { getErrorMessage } from '../../utils/error'
import { BRANCHES_KEY, type BranchesData } from './useBranchesData'
import { RetryToastMessage } from '../components/RetryToastMessage'
import { EDITOR_ACTIONS } from '../copy'
import {
  GAVE_UP_MESSAGE,
  REQUEST_FAILED_MESSAGE,
  SAVE_FIRST_REASON,
  UNANSWERED_MESSAGE,
  baseUpdatePollMs,
  baseUpdateResultMessage,
  baseUpdateWait,
  nextBaseUpdateWaitChange,
  type BaseUpdateWait,
} from '../base-update-wait'
import { serverNow } from '../server-clock'
import { UnansweredError, isGatewayFailure, isUnanswered } from '../unanswered'

const RESULT_TOAST_ID = 'canopy-base-update-result'

export interface UseBaseUpdateOptions {
  /** The open branch. */
  branch: BranchListItem | undefined
  operatingMode: OperatingMode
  /** The user may take the branch's workflow actions, which asking for the latest changes is. */
  permitted: boolean
  /** Entries with unsaved changes on the branch; asking waits until they are saved. */
  unsavedCount: number
  /** Re-read the branch's entries and the open one, keeping drafts: the worker rewrote them. */
  onUpdated: () => void
  /** Opens the branch's conflicts, offered by the toast of a merge that left some. */
  onShowConflicts?: () => void
}

export interface UseBaseUpdateReturn {
  /** "Get latest changes" applies here: a worker answers, the branch is editing, the user may ask. */
  available: boolean
  /** The open branch's wait; `waiting` makes its form read-only. */
  wait: BaseUpdateWait
  /** The open branch's request itself is in flight. */
  requesting: boolean
  /** Why it can't be asked now; undefined when it can. */
  blockedReason?: string
  /** Asks for the open branch, unless unsaved changes hold it. */
  request: () => Promise<void>
}

/** Writes the branch a request answered into the listing, so its wait shows at once. */
function withBranch(data: BranchesData | undefined, branch: BranchListItem) {
  if (!data) return data
  return { ...data, branches: data.branches.map((b) => (b.name === branch.name ? branch : b)) }
}

/** Whether `a` is a later request time than `b`, an absent one being earliest. */
const laterThan = (a: string, b: string | undefined) =>
  b === undefined || Date.parse(a) > Date.parse(b)

/**
 * A request this tab made or saw answered, by branch: its name and creation, since a branch deleted
 * and made again under the same name is another branch.
 */
interface Recorded {
  name: string
  createdAt: string
  requestedAt: string
}

const sameBranch = (branch: BranchListItem, record: Recorded | null): record is Recorded =>
  record?.name === branch.name && record.createdAt === branch.createdAt

/** The listed branch, carrying this tab's newer request. */
function withAsked(
  branch: BranchListItem | undefined,
  asked: Recorded | null,
): BranchListItem | undefined {
  if (!branch || !sameBranch(branch, asked)) return branch
  return laterThan(asked.requestedAt, branch.baseUpdateRequestedAt)
    ? { ...branch, baseUpdateRequestedAt: asked.requestedAt }
    : branch
}

/** The branch, carrying the answer this tab already reported when the listing hasn't caught up. */
function withSettled(
  branch: BranchListItem | undefined,
  settled: (Recorded & { lastBaseUpdate: LastBaseUpdate }) | null,
): BranchListItem | undefined {
  if (!branch || !sameBranch(branch, settled) || !isBaseUpdatePending(branch)) return branch
  return laterThan(branch.baseUpdateRequestedAt ?? '', settled.requestedAt) &&
    branch.baseUpdateRequestedAt !== undefined
    ? branch
    : {
        ...branch,
        baseUpdateRequestedAt: settled.requestedAt,
        lastBaseUpdate: settled.lastBaseUpdate,
      }
}

/**
 * A toast in the one slot this hook uses, replacing what it showed before. `onAction` offers
 * Retry, or `actionLabel`.
 */
function showResult(
  color: 'green' | 'yellow' | 'red',
  message: string,
  onAction?: () => void,
  actionLabel?: string,
) {
  notifications.hide(RESULT_TOAST_ID)
  notifications.show({
    id: RESULT_TOAST_ID,
    color,
    autoClose: color === 'green' ? undefined : false,
    message: onAction ? (
      <RetryToastMessage message={message} onRetry={onAction} actionLabel={actionLabel} />
    ) : (
      message
    ),
  })
}

/**
 * "Get latest changes" for the open branch: asks, then re-reads the branch list while the branch
 * waits, and reports the worker's answer in a toast once it lands. Only a wait this tab saw end
 * reports, so a reload onto an answered request stays quiet. The wait is timed by the server's
 * clock (server-clock.ts), and a request this tab made counts even when a listing fetched before
 * it lands after it.
 */
export function useBaseUpdate(options: UseBaseUpdateOptions): UseBaseUpdateReturn {
  const { operatingMode, permitted, unsavedCount, onUpdated } = options
  const apiClient = useApiClient()
  const { mutate } = useSWRConfig()
  const [requestingFor, setRequestingFor] = useState<string | null>(null)
  // The last request this tab made, by branch, which a listing that predates it can't undo.
  const [asked, setAsked] = useState<Recorded | null>(null)
  // The last answer this tab reported, by branch, which a listing that predates it can't undo:
  // another host can serve the branch list from an older snapshot.
  const [settled, setSettled] = useState<(Recorded & { lastBaseUpdate: LastBaseUpdate }) | null>(
    null,
  )
  const [, setTick] = useState(0)

  const listed = options.branch
  const name = listed?.name
  const branch = withSettled(withAsked(listed, asked), settled)

  const available =
    !!branch &&
    clientOperatingStrategy(operatingMode).syncsBranchesWithBase() &&
    branch.status === 'editing' &&
    branch.isProtected === false &&
    permitted
  const wait = baseUpdateWait(branch, serverNow())
  const requestedAt = branch?.baseUpdateRequestedAt
  const answer = branch?.lastBaseUpdate
  const status = branch?.status
  const createdAt = branch?.createdAt

  // The wait changes on its own at the slow and give-up marks; nothing else would re-render then.
  const changeAt = nextBaseUpdateWaitChange(branch, serverNow())
  useEffect(() => {
    if (changeAt === undefined) return
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, changeAt - serverNow()) + 50)
    return () => clearTimeout(timer)
  }, [changeAt])

  // Re-read the listing while the branch waits, on a timer of its own: SWR stops polling a key
  // whose last fetch failed, and one failed read must not end the wait. Each read starts only once
  // the last has settled, since SWR drops an in-flight read's result when another starts.
  const pollMs = baseUpdatePollMs(wait)
  useEffect(() => {
    if (pollMs === 0) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const next = () => {
      timer = setTimeout(async () => {
        if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
          await mutate(BRANCHES_KEY).catch(() => undefined)
        }
        if (!stopped) next()
      }, pollMs)
    }
    next()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [pollMs, mutate])

  const latest = useRef({ name, unsavedCount, available })
  latest.current = { name, unsavedCount, available }
  const onUpdatedRef = useRef(onUpdated)
  onUpdatedRef.current = onUpdated
  const onShowConflictsRef = useRef(options.onShowConflicts)
  onShowConflictsRef.current = options.onShowConflicts
  const requestRef = useRef<() => Promise<void>>(async () => {})
  // Stable, and reads only refs, so the toasts that carry it keep working.
  const retry = useCallback(() => {
    notifications.hide(RESULT_TOAST_ID)
    void requestRef.current()
  }, [])

  const report = useCallback(
    (on: Recorded, result: LastBaseUpdate) => {
      setSettled({ ...on, lastBaseUpdate: result })
      if (result.outcome !== 'failed') onUpdatedRef.current()
      if (result.outcome === 'conflicts') {
        // The toast counts the choices left, which the branch's conflicts hold.
        void apiClient.conflicts
          .list({ branch: on.name })
          .then((answer) => (answer.ok ? answer.data?.openCount : undefined))
          .catch(() => undefined)
          .then((count) => {
            if (latest.current.name !== on.name) return
            const { color, message } = baseUpdateResultMessage(result, count)
            const show = () => {
              notifications.hide(RESULT_TOAST_ID)
              onShowConflictsRef.current?.()
            }
            showResult(
              color,
              message,
              onShowConflictsRef.current && count !== 0 ? show : undefined,
              EDITOR_ACTIONS.showChanges,
            )
          })
        return
      }
      const { color, message } = baseUpdateResultMessage(result)
      // Retry only for someone who may ask; another viewer just learns how it went.
      const canRetry = result.outcome === 'failed' && latest.current.available
      showResult(color, message, canRetry ? retry : undefined)
    },
    [apiClient, retry],
  )

  // A result is about the branch it came from: switching away closes it.
  useEffect(
    () => () => {
      notifications.hide(RESULT_TOAST_ID)
    },
    [name],
  )

  // A wait this tab saw, by branch and request, reports when its answer lands, even after the
  // editor stopped waiting on it; giving up says so, once.
  const watched = useRef<{ name: string; requestedAt: string; gaveUp: boolean } | undefined>(
    undefined,
  )
  useEffect(() => {
    if (!name || !requestedAt) return
    const seen = watched.current
    const same = seen?.name === name && seen.requestedAt === requestedAt
    if (wait !== 'none') {
      if (!same) watched.current = { name, requestedAt, gaveUp: false }
      return
    }
    if (!seen || !same) return
    if (
      answer &&
      !isBaseUpdatePending({ baseUpdateRequestedAt: requestedAt, lastBaseUpdate: answer })
    ) {
      watched.current = undefined
      report({ name, createdAt: createdAt ?? '', requestedAt }, answer)
    } else if (!seen.gaveUp && status === 'editing') {
      seen.gaveUp = true
      showResult('yellow', GAVE_UP_MESSAGE)
    }
  }, [name, createdAt, requestedAt, answer, wait, status, report])

  const request = useCallback(async () => {
    const target = latest.current.name
    if (!target) return
    if (latest.current.unsavedCount > 0) {
      showResult('yellow', SAVE_FIRST_REASON)
      return
    }
    // What lands after the user moved to another branch is about that one, not this.
    const stillOpen = () => latest.current.name === target
    setRequestingFor(target)
    try {
      try {
        const result = await apiClient.workflow.updateFromBase({ branch: target })
        if (isGatewayFailure(result)) throw new UnansweredError()
        if (result.ok && result.data) {
          const { branch: answered, requestedAt: at } = result.data
          await mutate(BRANCHES_KEY, (data?: BranchesData) => withBranch(data, answered), {
            revalidate: false,
          })
          if (!stillOpen()) return
          const on = { name: target, createdAt: answered.createdAt, requestedAt: at }
          setAsked(on)
          if (!isBaseUpdatePending(answered) && answered.lastBaseUpdate) {
            report(on, answered.lastBaseUpdate)
          } else {
            watched.current = { name: target, requestedAt: at, gaveUp: false }
          }
          return
        }
        // A refusal can mean the branch moved on (submitted meanwhile): re-read it, and offer Retry
        // only if it can still ask.
        const fresh = await mutate<BranchesData>(BRANCHES_KEY)
        if (!stillOpen()) return
        const now = fresh?.branches.find((b) => b.name === target)
        const canRetry = now === undefined || now.status === 'editing'
        // A 409 is a conflict with the branch's state, which the guidelines colour yellow.
        showResult(
          result.status === 409 ? 'yellow' : 'red',
          result.error ?? REQUEST_FAILED_MESSAGE,
          canRetry ? retry : undefined,
        )
      } catch (err) {
        if (!isUnanswered(err)) throw err
        // It may have gone through, and a reload that shows the wait settles it.
        const fresh = await mutate<BranchesData>(BRANCHES_KEY)
        if (!stillOpen()) return
        const reloaded = fresh?.branches.find((b) => b.name === target)
        if (baseUpdateWait(reloaded, serverNow()) === 'none') {
          showResult('yellow', UNANSWERED_MESSAGE, retry)
        }
      }
    } catch (err) {
      if (!stillOpen()) return
      notifications.hide(RESULT_TOAST_ID)
      notifications.show({
        id: RESULT_TOAST_ID,
        color: 'red',
        autoClose: false,
        message: (
          <RetryToastMessage
            message={REQUEST_FAILED_MESSAGE}
            onRetry={retry}
            details={getErrorMessage(err)}
          />
        ),
      })
    } finally {
      setRequestingFor((current) => (current === target ? null : current))
    }
  }, [apiClient, mutate, report, retry])
  requestRef.current = request

  return {
    available,
    wait,
    requesting: !!name && requestingFor === name,
    blockedReason: unsavedCount > 0 ? SAVE_FIRST_REASON : undefined,
    request,
  }
}
