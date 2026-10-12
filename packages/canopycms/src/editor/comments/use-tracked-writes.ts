'use client'

import { useEffect, useRef, useState } from 'react'
import { notifications } from '@mantine/notifications'
import { getErrorMessage } from '../../utils/error'

/** Shown while a surface refuses to close because a comment write is still in flight. */
export const CLOSE_WAITS_FOR_WRITE = 'Still saving… You can close this once it finishes.'

/**
 * Wraps a surface's comment writes: `inFlight` counts the unsettled ones, and a write that fails
 * after the surface unmounted (the Branches drawer closed under the branch discussion, another
 * entry or branch opened) still reports, as a toast, since nothing is left on screen to show the
 * error. A wrapped write still rejects for its caller. `holdOpen()` is true while a write is in
 * flight, and then sets `closeRefused` until the writes settle, which the API client's request
 * deadline bounds, so a surface that refuses to close can say why.
 */
export function useTrackedWrites(): {
  inFlight: number
  track: <A extends unknown[]>(
    write: (...args: A) => Promise<void>,
  ) => (...args: A) => Promise<void>
  holdOpen: () => boolean
  closeRefused: boolean
} {
  const [inFlight, setInFlight] = useState(0)
  const [closeRefused, setCloseRefused] = useState(false)
  if (closeRefused && inFlight === 0) setCloseRefused(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const track =
    <A extends unknown[]>(write: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      setInFlight((n) => n + 1)
      try {
        await write(...args)
      } catch (err) {
        if (!mountedRef.current) {
          notifications.show({ color: 'red', message: getErrorMessage(err), autoClose: false })
        }
        throw err
      } finally {
        setInFlight((n) => n - 1)
      }
    }
  const holdOpen = () => {
    if (inFlight > 0) setCloseRefused(true)
    return inFlight > 0
  }
  return { inFlight, track, holdOpen, closeRefused }
}
