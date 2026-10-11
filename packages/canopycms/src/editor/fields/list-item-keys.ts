import { useRef } from 'react'

/**
 * Keys for the items of object lists and block lists. An object listed once keeps the key it
 * was first shown with, so an append remounts no item, a removal never hands a crashed item's
 * boundary to the next one, and an item put back by Undo (the same object) gets its key back. A
 * list whose length is unchanged (an edited item, the saved copy of the same items) keeps keys by
 * position. One instance serves every list a component renders, told apart by `listPath`.
 */
export function useListItemKeys(): (items: readonly unknown[], listPath: string) => string[] {
  const listItemKeys = useRef(new WeakMap<object, string>())
  const lastListKeys = useRef(new Map<string, string[]>())
  const nextListItemKey = useRef(0)
  return (items, listPath) => {
    const previous = lastListKeys.current.get(listPath)
    const occurrences = new Map<object, number>()
    for (const item of items) {
      if (typeof item === 'object' && item !== null) {
        occurrences.set(item, (occurrences.get(item) ?? 0) + 1)
      }
    }
    // Only an object listed once has an identity; a repeated one is keyed by position.
    const single = (item: unknown): item is object =>
      typeof item === 'object' && item !== null && occurrences.get(item) === 1
    const claimed = new Set<string>()
    const keys = items.map((item) => {
      const own = single(item) ? listItemKeys.current.get(item) : undefined
      // Two objects can hold one key, an edited copy having inherited its original's.
      if (own === undefined || claimed.has(own)) return undefined
      claimed.add(own)
      return own
    })
    // The rest inherit their position's key, never one an object present here holds.
    const resolved = keys.map((key, idx) => {
      if (key !== undefined) return key
      let next = previous?.length === items.length ? previous[idx] : undefined
      if (next === undefined || claimed.has(next)) {
        nextListItemKey.current += 1
        next = `item-${nextListItemKey.current}`
      }
      claimed.add(next)
      const item = items[idx]
      if (single(item)) listItemKeys.current.set(item, next)
      return next
    })
    lastListKeys.current.set(listPath, resolved)
    return resolved
  }
}
