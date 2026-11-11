/**
 * Which item of the ancestor's list each item of one side's list is, for the field merge. A side's
 * item is the ancestor's item when it carries a key the ancestor knows; otherwise it is ALIGNED to
 * the ancestor the way diff3 aligns lines: equal content first, then, inside a gap between two
 * matches, item by item by position when the gap holds as many unmatched items on both sides (an
 * item edited in place). Anything left is new on that side.
 */

import { ITEM_KEY, isItemKey, itemKeysAsRead } from '../item-keys'
import { isPlainRecord } from '../validation/field-traversal'
import { commonPairs } from './diff3'
import { valueToken } from './value-equality'

/** Marks an identity no file holds: a side's new item. Item keys never contain it. */
const INTERNAL = '\u0000'

const ownKey = (item: unknown): string | undefined =>
  isPlainRecord(item) && isItemKey(item[ITEM_KEY]) ? item[ITEM_KEY] : undefined

/** `value` with every item key dropped, and each bare date at UTC midnight as its day. */
const asKeyedContent = (value: unknown, dropAll: boolean): unknown => {
  if (value instanceof Date && value.getTime() % 86_400_000 === 0) {
    return value.toISOString().slice(0, 10)
  }
  if (Array.isArray(value)) return value.map((v) => asKeyedContent(v, dropAll))
  if (!isPlainRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !(dropAll && k === ITEM_KEY))
      .map(([k, v]) => [k, asKeyedContent(v, dropAll)]),
  )
}

const withoutOwnKey = (item: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(item).filter(([k]) => k !== ITEM_KEY))

/**
 * True when `key` is a hash of `item`'s own content, as a read or a key backfill writes it down
 * (`-2` and on for a repeated item), so it says nothing about which item this is. Any other key
 * was minted for the item when it was added.
 */
const isContentKey = (item: Record<string, unknown>, key: string): boolean => {
  const content = withoutOwnKey(item)
  const hashes = [content, asKeyedContent(content, false), asKeyedContent(content, true)].map(
    (c) => itemKeysAsRead([c])[0],
  )
  const base = key.replace(/-\d+$/, '')
  return hashes.includes(key) || hashes.includes(base)
}

/** An item carrying a usable key that is not a hash of its content: a key minted for it. */
const isMinted = (item: unknown): boolean => {
  const key = ownKey(item)
  return key !== undefined && !isContentKey(item as Record<string, unknown>, key)
}

/**
 * The other keys a read could have given each ancestor item, mapped to the item's key: its
 * content hashed with bare dates as days or with the keys inside it dropped, as a read that knew
 * the schema, or ran before nested lists were keyed, hashed it. A side's key matching one names
 * that ancestor item: an editor's first save keys an item as read and may edit it in the same save.
 */
const ancestorAliases = (
  ancestorItems: readonly unknown[],
  ancestorKeys: readonly string[],
): Map<string, string> => {
  const aliases = new Map<string, string>()
  for (const dropAll of [false, true]) {
    const variants = ancestorItems.map((item) =>
      isPlainRecord(item) ? asKeyedContent(withoutOwnKey(item), dropAll) : item,
    )
    itemKeysAsRead(variants).forEach((alias, i) => {
      if (alias !== undefined && !aliases.has(alias)) aliases.set(alias, ancestorKeys[i])
    })
  }
  return aliases
}

/**
 * Each item of `items`' identity: the key of the ancestor item it is, or, for an item new on this
 * side, an internal identity unique to it. `ancestorKeys` are the ancestor's items' keys as a read
 * gives them, so an item an editor's first save keyed carries one the ancestor knows.
 *
 * A key is identity only when the ancestor knows it, under any key a read could have given it
 * ({@link ancestorAliases}). A key added since that is a hash of the item's own content (a backfill run after the item was edited) is aligned like a missing one; any
 * other new key was minted for an item added on this side, which is new and aligned to nothing,
 * so a delete and an add in its place never read as an edit. A key a later item repeats is
 * identity for the first holder only, as a read keys the list.
 */
export function alignToAncestor(
  items: readonly unknown[],
  ancestorItems: readonly unknown[],
  ancestorKeys: readonly string[],
  side: string,
): string[] | undefined {
  const known = new Set(ancestorKeys)
  const aliases = ancestorAliases(ancestorItems, ancestorKeys)
  const ids: Array<string | undefined> = items.map(() => undefined)
  const taken = new Set<string>()
  const minted = new Set<number>()
  items.forEach((item, j) => {
    const key = ownKey(item)
    if (key === undefined) return
    const id = known.has(key) ? key : aliases.get(key)
    if (id !== undefined && !taken.has(id)) {
      ids[j] = id
      taken.add(id)
    } else if (isMinted(item)) {
      minted.add(j)
    }
  })
  // Items matched by key anchor the alignment too, where they kept their order.
  const ancestorTokens = ancestorItems.map((item, i) =>
    taken.has(ancestorKeys[i]) ? `${INTERNAL}k${ancestorKeys[i]}` : `c${valueToken(item)}`,
  )
  const sideTokens = items.map((item, j) => {
    const id = ids[j]
    if (minted.has(j)) return `${INTERNAL}m${j}`
    return id !== undefined ? `${INTERNAL}k${id}` : `c${valueToken(item)}`
  })
  const anchors = commonPairs(ancestorTokens, sideTokens)
  if (!anchors) return undefined
  for (const [i, j] of anchors) {
    if (ids[j] === undefined) {
      ids[j] = ancestorKeys[i]
      taken.add(ancestorKeys[i])
    }
  }
  // An ancestor item whose stored key was minted for it is that item only under that key: a
  // side item in its place without the key replaced it, unless the content is the same.
  const pairable = (i: number) => !taken.has(ancestorKeys[i]) && !isMinted(ancestorItems[i])
  const bounds: Array<[number, number]> = [
    [-1, -1],
    ...anchors,
    [ancestorItems.length, items.length],
  ]
  for (let n = 0; n + 1 < bounds.length; n++) {
    const ancestorGap: number[] = []
    const sideGap: number[] = []
    for (let i = bounds[n][0] + 1; i < bounds[n + 1][0]; i++) {
      if (pairable(i)) ancestorGap.push(i)
    }
    for (let j = bounds[n][1] + 1; j < bounds[n + 1][1]; j++) {
      if (ids[j] === undefined && !minted.has(j)) sideGap.push(j)
    }
    if (ancestorGap.length === sideGap.length) {
      ancestorGap.forEach((i, k) => {
        ids[sideGap[k]] = ancestorKeys[i]
        taken.add(ancestorKeys[i])
      })
    }
  }
  // An item left over whose content an unmatched ancestor item has was moved there.
  const unmatched = new Map<string, number[]>()
  ancestorItems.forEach((item, i) => {
    if (taken.has(ancestorKeys[i])) return
    const token = valueToken(item)
    unmatched.set(token, [...(unmatched.get(token) ?? []), i])
  })
  items.forEach((item, j) => {
    if (ids[j] !== undefined || minted.has(j)) return
    const i = unmatched.get(valueToken(item))?.shift()
    if (i === undefined) return
    ids[j] = ancestorKeys[i]
    taken.add(ancestorKeys[i])
  })
  return ids.map((id, j) => id ?? newIdentity(side, j))
}

/** The identity of the `j`th item of `side`'s list, new on that side. */
export const newIdentity = (side: string, j: number): string => `${INTERNAL}${side}${j}`

/** True for an identity {@link alignToAncestor} gave an item new on its side. */
export const isNewIdentity = (id: string): boolean => id.startsWith(INTERNAL)

/**
 * Pairs the items new on the base with the items new on the branch that are the same addition:
 * the same key, else equal content, in order. The branch's identity replaces the base's in
 * `baseIds` for each pair, so an item both sides added alike is one item. Pairing is skipped by
 * content when the diff runs out of time: the additions stay apart, and none is lost.
 */
export function pairNewItems(
  baseItems: readonly unknown[],
  baseIds: string[],
  branchItems: readonly unknown[],
  branchIds: readonly string[],
): void {
  const baseNew = baseIds.flatMap((id, j) => (isNewIdentity(id) ? [j] : []))
  const branchNew = branchIds.flatMap((id, j) => (isNewIdentity(id) ? [j] : []))
  const pairedBase = new Set<number>()
  const pairedBranch = new Set<number>()
  const branchByKey = new Map<string, number>()
  for (const j of branchNew) {
    const key = ownKey(branchItems[j])
    if (key !== undefined && !branchByKey.has(key)) branchByKey.set(key, j)
  }
  for (const j of baseNew) {
    const key = ownKey(baseItems[j])
    const match = key === undefined ? undefined : branchByKey.get(key)
    if (match !== undefined && !pairedBranch.has(match)) {
      baseIds[j] = branchIds[match]
      pairedBase.add(j)
      pairedBranch.add(match)
    }
  }
  // Equal content pairs two additions unless both carry keys minted for them: those are two
  // items that happen to read alike.
  const restBase = baseNew.filter((j) => !pairedBase.has(j))
  const restBranch = branchNew.filter((j) => !pairedBranch.has(j))
  const pairs = (
    commonPairs(
      restBase.map((j) => valueToken(baseItems[j])),
      restBranch.map((j) => valueToken(branchItems[j])),
    ) ?? []
  ).filter(([x, y]) => !(isMinted(baseItems[restBase[x]]) && isMinted(branchItems[restBranch[y]])))
  for (const [x, y] of pairs) baseIds[restBase[x]] = branchIds[restBranch[y]]
}

/**
 * The order of the merged list's identities: one side's order, with the items only the other side
 * holds placed after the item that precedes them there. The branch's order leads unless the
 * branch kept the ancestor's order and the base did not, so a reorder on one side applies, and a
 * reorder on both sides takes the branch's.
 */
export function mergeOrder(
  ancestorIds: readonly string[],
  baseIds: readonly string[],
  branchIds: readonly string[],
): string[] {
  const inBase = new Set(baseIds)
  const inBranch = new Set(branchIds)
  const inAncestor = new Set(ancestorIds)
  const shared = (id: string) => inAncestor.has(id) && inBase.has(id) && inBranch.has(id)
  const ancestorOrder = ancestorIds.filter(shared)
  const reordered = (ids: readonly string[]) =>
    ids.filter(shared).some((id, n) => id !== ancestorOrder[n])
  const baseLeads = !reordered(branchIds) && reordered(baseIds)
  const [lead, other] = baseLeads ? [baseIds, branchIds] : [branchIds, baseIds]
  const inLead = new Set(lead)
  const after = new Map<string | undefined, string[]>()
  let anchor: string | undefined
  for (const id of other) {
    if (inLead.has(id)) {
      anchor = id
      continue
    }
    const run = after.get(anchor)
    if (run) run.push(id)
    else after.set(anchor, [id])
  }
  return [...(after.get(undefined) ?? []), ...lead.flatMap((id) => [id, ...(after.get(id) ?? [])])]
}
