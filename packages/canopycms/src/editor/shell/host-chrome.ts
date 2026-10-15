'use client'

import { useEffect, type RefObject } from 'react'

const REACT_FIBER_KEY_PREFIX = '__reactFiber$'

function reactFiberKey(element: Element): string | undefined {
  return Object.keys(element).find((key) => key.startsWith(REACT_FIBER_KEY_PREFIX))
}

/**
 * @internal Exported for tests. The host page's chrome around `anchor`, an element the editor
 * renders in place: the `<body>` child holding it, plus every `<body>` child the same copy of React
 * rendered (a Next.js root layout's header and footer). That copy's fiber key has a random suffix,
 * so portal containers and other libraries' roots, such as Clerk's, never match it.
 */
export function findHostChrome(anchor: Element): HTMLElement[] {
  const body = anchor.ownerDocument.body
  let root: Element = anchor
  while (root.parentElement && root.parentElement !== body) root = root.parentElement
  if (root.parentElement !== body) return []

  const fiberKey = reactFiberKey(anchor)
  const siblings = fiberKey
    ? Array.from(body.children).filter((child) => child !== root && fiberKey in child)
    : []
  return [root, ...siblings].filter((element) => element instanceof HTMLElement)
}

interface Hold {
  count: number
  restore: () => void
}

/** Per element, so a second editor mounted at once never restores what the first still hides. */
const holds = new WeakMap<HTMLElement, Hold>()

function hide(element: HTMLElement): () => void {
  let hold = holds.get(element)
  if (!hold) {
    const wasInert = element.hasAttribute('inert')
    const { visibility } = element.style
    element.setAttribute('inert', '')
    element.style.visibility = 'hidden'
    hold = {
      count: 0,
      restore: () => {
        if (!wasInert) element.removeAttribute('inert')
        element.style.visibility = visibility
      },
    }
    holds.set(element, hold)
  }
  hold.count++
  const held = hold
  return () => {
    if (--held.count > 0) return
    holds.delete(element)
    held.restore()
  }
}

/**
 * Makes the host's chrome inert and hidden while the editor is mounted: Tab never leaves the
 * editor, and chrome with its own z-index never paints over the shell. Applied once, at mount,
 * since an element added later may be a third-party popup that must stay usable; unmount restores
 * exactly what this changed.
 */
export function useHideHostChrome(anchorRef: RefObject<Element | null>): void {
  useEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const releases = findHostChrome(anchor).map(hide)
    return () => releases.forEach((release) => release())
  }, [anchorRef])
}
