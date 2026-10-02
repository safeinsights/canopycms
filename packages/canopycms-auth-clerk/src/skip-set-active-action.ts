'use client'

import { useEffect } from 'react'

const HOOK_NAMES = ['__internal_onBeforeSetActive', '__unstable__onBeforeSetActive'] as const
const resolveNow = (): Promise<void> => Promise.resolve()
let holders = 0
const replaced = new Map<string, unknown>()

/**
 * Makes `@clerk/nextjs`'s before-`setActive` hook resolve at once instead of running a Server
 * Action, which 403s behind CloudFront OAC and leaves sign-in hanging. Call it in a component
 * inside `<ClerkProvider>`: the editor already does (see the README for your own pages).
 */
export function useSkipClerkSetActiveAction(): void {
  useEffect(() => {
    const slots = window as unknown as Record<string, unknown>
    if (holders++ === 0) {
      for (const name of HOOK_NAMES) {
        if (typeof slots[name] === 'function') {
          replaced.set(name, slots[name])
          slots[name] = resolveNow
        }
      }
    }
    return () => {
      if (--holders > 0) return
      for (const [name, original] of replaced) {
        if (slots[name] === resolveNow) slots[name] = original
      }
      replaced.clear()
    }
  }, [])
}
