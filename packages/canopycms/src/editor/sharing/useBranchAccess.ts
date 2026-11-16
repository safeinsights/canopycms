'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import type { ApiErrorCode } from '../../api/types'
import { useApiClient } from '../context/ApiClientContext'
import type { BranchAccess } from './share-staging'

/** Codes after which the viewer can do nothing more with the list, so the dialog offers only Close. */
const LOCKOUT_CODES: ReadonlySet<ApiErrorCode> = new Set([
  'BRANCH_ACCESS_DENIED',
  'BRANCH_LOCKED_DOWN',
  'BRANCH_ARCHIVED',
  'BRANCH_NOT_SHAREABLE',
  'ACCESS_ADD_FORBIDDEN',
  'ACCESS_MANAGE_FORBIDDEN',
])

/** A refusal naming `ids` turns down one change, never the viewer, so it is no lockout. */
export const isLockout = (
  code: ApiErrorCode | undefined,
  ids?: readonly string[],
): code is ApiErrorCode => !!code && LOCKOUT_CODES.has(code) && !ids?.length

export type BranchAccessState =
  | { status: 'loading'; data?: BranchAccess }
  | { status: 'loaded'; data: BranchAccess }
  | { status: 'failed'; data?: BranchAccess }
  | { status: 'refused'; code: ApiErrorCode; data?: BranchAccess }

/**
 * GET /:branch/access for `branch`, read on mount. `reload` keeps what was shown while it reads,
 * and resolves to the fresh list, or undefined when the read failed, was refused or was overtaken.
 */
export function useBranchAccess(branch: string): {
  state: BranchAccessState
  reload: () => Promise<BranchAccess | undefined>
} {
  const client = useApiClient()
  const [state, setState] = useState<BranchAccessState>({ status: 'loading' })
  const seq = useRef(0)

  const reload = useCallback(async (): Promise<BranchAccess | undefined> => {
    const mine = ++seq.current
    setState((prev) => ({ status: 'loading', data: prev.data }))
    let next: BranchAccessState
    try {
      const result = await client.branches.getAccess({ branch })
      next =
        result.ok && result.data
          ? { status: 'loaded', data: result.data }
          : isLockout(result.code)
            ? { status: 'refused', code: result.code }
            : { status: 'failed' }
    } catch (err: unknown) {
      console.error(err)
      next = { status: 'failed' }
    }
    if (mine !== seq.current) return undefined
    setState((prev) => (next.status === 'failed' ? { status: 'failed', data: prev.data } : next))
    return next.status === 'loaded' ? next.data : undefined
  }, [client, branch])

  useEffect(() => {
    void reload()
  }, [reload])

  return { state, reload }
}
