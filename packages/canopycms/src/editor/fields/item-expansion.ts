import { useCallback, useContext, useEffect, useRef, useState } from 'react'

import { FormExpansionContext } from './form-expansion'

/** Up to this many rows all start expanded; a longer list starts with only its first open. */
const EXPAND_ALL_UP_TO = 3

export interface ItemExpansion {
  isExpanded: (key: string) => boolean
  setExpanded: (key: string, expanded: boolean) => void
  setAll: (expanded: boolean) => void
  /** True when every row is expanded; false for an empty list. */
  allExpanded: boolean
}

/**
 * Which rows of a collapsible list are open, by list-item key (`useListItemKeys`), so a row keeps
 * its state through moves, and through a Remove and its Undo. A list inside a row that moves
 * remounts and starts over. A list's first rows start open as `EXPAND_ALL_UP_TO` says; a row added
 * later (Add, Duplicate) starts open. With `rowsStartOpen: false`, every row starts shut, for a
 * list whose collapsed rows already say all it holds. `resetKey` names the entry being edited: a
 * new one starts over. The form's own Expand all and Collapse all (`FormExpansionContext`) reach
 * every list.
 */
export function useItemExpansion(
  itemKeys: readonly string[],
  resetKey: string,
  { rowsStartOpen = true }: { rowsStartOpen?: boolean } = {},
): ItemExpansion {
  const [toggled, setToggled] = useState<{ resetKey: string; open: Map<string, boolean> }>(() => ({
    resetKey,
    open: new Map(),
  }))
  // Decided once per key, the first time it renders, and kept until `resetKey` changes.
  const defaults = useRef<{ resetKey: string; open: Map<string, boolean>; started: boolean }>({
    resetKey,
    open: new Map(),
    started: false,
  })
  if (defaults.current.resetKey !== resetKey) {
    defaults.current = { resetKey, open: new Map(), started: false }
  }
  const firstPopulation = !defaults.current.started && itemKeys.length > 0
  itemKeys.forEach((key, idx) => {
    if (defaults.current.open.has(key)) return
    defaults.current.open.set(
      key,
      rowsStartOpen && (firstPopulation ? idx === 0 || itemKeys.length <= EXPAND_ALL_UP_TO : true),
    )
  })
  if (itemKeys.length > 0) defaults.current.started = true

  const explicit = toggled.resetKey === resetKey ? toggled.open : undefined
  const isExpanded = (key: string): boolean =>
    explicit?.get(key) ?? defaults.current.open.get(key) ?? true

  const setExpanded = useCallback(
    (key: string, expanded: boolean) =>
      setToggled((prev) => {
        const open = new Map(prev.resetKey === resetKey ? prev.open : undefined)
        open.set(key, expanded)
        return { resetKey, open }
      }),
    [resetKey],
  )

  const setAll = (expanded: boolean) =>
    setToggled(() => ({ resetKey, open: new Map(itemKeys.map((key) => [key, expanded])) }))

  const command = useContext(FormExpansionContext)
  const appliedSeq = useRef(command?.seq)
  const keysRef = useRef(itemKeys)
  useEffect(() => {
    keysRef.current = itemKeys
  })
  useEffect(() => {
    if (!command || command.seq === appliedSeq.current) return
    appliedSeq.current = command.seq
    setToggled({ resetKey, open: new Map(keysRef.current.map((key) => [key, command.expanded])) })
  }, [command, resetKey])

  return {
    isExpanded,
    setExpanded,
    setAll,
    allExpanded: itemKeys.length > 0 && itemKeys.every(isExpanded),
  }
}
