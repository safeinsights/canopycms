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
import {
  SAVE_FIRST_REASON,
  baseUpdateResultMessage,
  baseUpdateWait,
  nextBaseUpdateWaitChange,
  type BaseUpdateWait,
} from '../base-update-wait'
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
}

export interface UseBaseUpdateReturn {
  /** "Get latest changes" applies here: a worker answers, the branch is editing, the user may ask. */
  available: boolean
  /** The open branch's wait; `waiting` makes its form read-only. */
  wait: BaseUpdateWait
  /** The request itself is in flight. */
  requesting: boolean
  /** Why it can't be asked now; undefined when it can. */
  blockedReason?: string
  /** Asks for `target`, the open branch by default; a withdraw asks for the branch it withdrew. */
  request: (target?: string) => Promise<void>
}

/** Writes the branch a request answered into the listing, so its wait shows at once. */
function withBranch(data: BranchesData | undefined, branch: BranchListItem) {
  if (!data) return data
  return { ...data, branches: data.branches.map((b) => (b.name === branch.name ? branch : b)) }
}

/**
 * "Get latest changes" for the open branch: asks, then waits for the worker's answer, which the
 * branch list's poll (useBranchesData) brings in, and reports it in a toast once it lands. Only a
 * wait this tab saw end reports, so a reload onto an answered request stays quiet.
 */
export function useBaseUpdate(options: UseBaseUpdateOptions): UseBaseUpdateReturn {
  const { branch, operatingMode, permitted, unsavedCount, onUpdated } = options
  const apiClient = useApiClient()
  const { mutate } = useSWRConfig()
  const [requesting, setRequesting] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const available =
    !!branch &&
    clientOperatingStrategy(operatingMode).syncsBranchesWithBase() &&
    branch.status === 'editing' &&
    branch.isProtected === false &&
    permitted
  const wait = baseUpdateWait(branch, Math.max(now, Date.now()))

  // The wait changes on its own at the slow and give-up marks; nothing else would re-render then.
  const changeAt = nextBaseUpdateWaitChange(branch, Date.now())
  useEffect(() => {
    if (changeAt === undefined) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, changeAt - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [changeAt])

  const onUpdatedRef = useRef(onUpdated)
  onUpdatedRef.current = onUpdated
  const requestRef = useRef<() => Promise<void>>(async () => {})

  const report = useCallback((answer: LastBaseUpdate) => {
    const { color, message, sticky } = baseUpdateResultMessage(answer)
    notifications.hide(RESULT_TOAST_ID)
    notifications.show({
      id: RESULT_TOAST_ID,
      color,
      autoClose: sticky ? false : undefined,
      message:
        answer.outcome === 'failed' ? (
          <RetryToastMessage
            message={message}
            onRetry={() => {
              notifications.hide(RESULT_TOAST_ID)
              void requestRef.current()
            }}
          />
        ) : (
          message
        ),
    })
    if (answer.outcome !== 'failed') onUpdatedRef.current()
  }, [])

  // A wait this tab saw, by branch and request, reports when the answer lands.
  const watched = useRef<{ name: string; requestedAt: string } | undefined>(undefined)
  const name = branch?.name
  const requestedAt = branch?.baseUpdateRequestedAt
  const answer = branch?.lastBaseUpdate
  useEffect(() => {
    if (!name || !requestedAt) return
    if (wait !== 'none') {
      watched.current = { name, requestedAt }
      return
    }
    const seen = watched.current
    if (seen?.name !== name || seen.requestedAt !== requestedAt) return
    watched.current = undefined
    if (
      answer &&
      !isBaseUpdatePending({ baseUpdateRequestedAt: requestedAt, lastBaseUpdate: answer })
    )
      report(answer)
  }, [name, requestedAt, answer, wait, report])

  const request = useCallback(
    async (target = name) => {
      if (!target) return
      const open = target === name
      setRequesting(open)
      try {
        let failure: string
        try {
          const result = await apiClient.workflow.updateFromBase({ branch: target })
          if (isGatewayFailure(result)) throw new UnansweredError()
          if (result.ok && result.data) {
            const asked = result.data.branch
            await mutate(BRANCHES_KEY, (data?: BranchesData) => withBranch(data, asked), {
              revalidate: false,
            })
            setNow(Date.now())
            // Joined to a request already answered: report that answer now.
            if (asked.lastBaseUpdate && !isBaseUpdatePending(asked)) report(asked.lastBaseUpdate)
            else if (open) watched.current = { name: target, requestedAt: result.data.requestedAt }
            return
          }
          failure = result.error ?? "The latest changes couldn't be requested."
        } catch (err) {
          if (!isUnanswered(err)) throw err
          // It may have gone through, and a reload that shows the wait settles it.
          const fresh = await mutate<BranchesData>(BRANCHES_KEY)
          const reloaded = fresh?.branches.find((b) => b.name === target)
          if (baseUpdateWait(reloaded, Date.now()) !== 'none' && reloaded?.baseUpdateRequestedAt) {
            if (open)
              watched.current = { name: target, requestedAt: reloaded.baseUpdateRequestedAt }
            return
          }
          failure = "The server didn't answer, so the latest changes may not have been requested."
        }
        notifications.hide(RESULT_TOAST_ID)
        notifications.show({
          id: RESULT_TOAST_ID,
          color: 'red',
          autoClose: false,
          message: (
            <RetryToastMessage
              message={failure}
              onRetry={() => {
                notifications.hide(RESULT_TOAST_ID)
                void requestRef.current()
              }}
            />
          ),
        })
      } catch (err) {
        notifications.show({ color: 'red', autoClose: false, message: getErrorMessage(err) })
      } finally {
        setRequesting(false)
      }
    },
    [apiClient, mutate, name, report],
  )
  requestRef.current = request

  return {
    available,
    wait,
    requesting,
    blockedReason: unsavedCount > 0 ? SAVE_FIRST_REASON : undefined,
    request,
  }
}
