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
    const restores = findHostChrome(anchor).map((element) => {
      const wasInert = element.hasAttribute('inert')
      const { visibility } = element.style
      element.setAttribute('inert', '')
      element.style.visibility = 'hidden'
      return () => {
        if (!wasInert) element.removeAttribute('inert')
        element.style.visibility = visibility
      }
    })
    return () => restores.forEach((restore) => restore())
  }, [anchorRef])
}
