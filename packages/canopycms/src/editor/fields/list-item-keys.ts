import { useRef } from 'react'

/**
 * Keys for the items of object lists, block lists and reference lists. An object, or a string,
 * listed once keeps the key it was first shown with, so a move carries its row's state along, an
 * append remounts no item, a removal never hands a crashed item's boundary to the next one, and an
 * item put back by Undo (the same object, the same string) gets its key back. A list whose length
 * is unchanged (an edited item, a repointed reference, the saved copy of the same items) keeps keys
 * by position. One instance serves every list a component renders, told apart by `listPath`.
 */
export function useListItemKeys(): (items: readonly unknown[], listPath: string) => string[] {
  const listItemKeys = useRef(new WeakMap<object, string>())
  // Strings can't key a WeakMap, and one id may sit in two lists, so each list keeps its own.
  const stringKeys = useRef(new Map<string, Map<string, string>>())
  const lastListKeys = useRef(new Map<string, string[]>())
  const lastListItems = useRef(new Map<string, readonly unknown[]>())
  const nextListItemKey = useRef(0)
  return (items, listPath) => {
    const previous = lastListKeys.current.get(listPath)
    const previousItems = lastListItems.current.get(listPath)
    let ownStrings = stringKeys.current.get(listPath)
    if (!ownStrings) {
      ownStrings = new Map()
      stringKeys.current.set(listPath, ownStrings)
    }
    const occurrences = new Map<unknown, number>()
    for (const item of items) {
      if ((typeof item === 'object' && item !== null) || typeof item === 'string') {
        occurrences.set(item, (occurrences.get(item) ?? 0) + 1)
      }
    }
    // Only an item listed once has an identity; a repeated one is keyed by position.
    const single = (item: unknown): item is object | string =>
      ((typeof item === 'object' && item !== null) || typeof item === 'string') &&
      occurrences.get(item) === 1
    const sameLength = previous?.length === items.length
    const ownKey = (item: object | string): string | undefined => {
      if (typeof item !== 'string') return listItemKeys.current.get(item)
      // A string new to a list of unchanged length took an item's place (a repoint), so it takes
      // that position's key rather than one it held before.
      if (sameLength && !previousItems?.includes(item)) return undefined
      return ownStrings.get(item)
    }
    const claimed = new Set<string>()
    const keys = items.map((item) => {
      const own = single(item) ? ownKey(item) : undefined
      // Two objects can hold one key, an edited copy having inherited its original's.
      if (own === undefined || claimed.has(own)) return undefined
      claimed.add(own)
      return own
    })
    // The rest inherit their position's key, never one an item present here holds.
    const resolved = keys.map((key, idx) => {
      if (key !== undefined) return key
      let next = sameLength ? previous?.[idx] : undefined
      if (next === undefined || claimed.has(next)) {
        nextListItemKey.current += 1
        next = `item-${nextListItemKey.current}`
      }
      claimed.add(next)
      const item = items[idx]
      if (single(item)) {
        if (typeof item === 'string') {
          // The string it replaced gives the key up, so that string returns with a key of its own.
          for (const [held, key] of ownStrings) if (key === next) ownStrings.delete(held)
          ownStrings.set(item, next)
        } else {
          listItemKeys.current.set(item, next)
        }
      }
      return next
    })
    lastListKeys.current.set(listPath, resolved)
    lastListItems.current.set(listPath, items)
    return resolved
  }
}
