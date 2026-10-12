'use client'

import { useEffect, useRef, useState } from 'react'
import { notifications } from '@mantine/notifications'
import { getErrorMessage } from '../../utils/error'

/**
 * Wraps a surface's comment writes: `inFlight` counts the unsettled ones, and a write that fails
 * after the surface unmounted (its drawer closed, its entry changed) still reports, as a toast,
 * since nothing is left on screen to show the error. A wrapped write still rejects for its caller.
 */
export function useTrackedWrites(): {
  inFlight: number
  track: <A extends unknown[]>(
    write: (...args: A) => Promise<void>,
  ) => (...args: A) => Promise<void>
} {
  const [inFlight, setInFlight] = useState(0)
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
  return { inFlight, track }
}
