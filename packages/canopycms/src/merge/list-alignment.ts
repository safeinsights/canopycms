/**
 * Which item of the ancestor's list each item of one side's list is, for the field merge. A side's
 * item is the ancestor's item when it carries a key the ancestor knows; otherwise it is ALIGNED to
 * the ancestor the way diff3 aligns lines: equal content in order, then equal content out of
 * order, then, inside a gap between two matches, by the values it kept, and last by place.
 * Anything left is new on that side. Aligning items no key names is the engine's one heuristic:
 * see `merge/AGENTS.md`.
 */

import {
  ITEM_KEY,
  hasContentKeyShape,
  hasMachineKeyShape,
  isItemKey,
  itemKeysAsRead,
} from '../item-keys'
import { isBlockStructuralKey } from '../validation/block-structural-keys'
import { isPlainRecord } from '../validation/field-traversal'
import { commonPairs } from './diff3'
import { isEmptyValue, valueToken } from './value-equality'

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
 * True when `key` is a hash of `item`'s own content (`-2` and on for a repeat), as a read or a key
 * backfill writes it, so it says nothing about which item this is; any other key was minted.
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

/** Which ancestor item each item of a side's list is. */
export interface Alignment {
  /** Per item: the ancestor item's key, or for an item new on this side an identity of its own. */
  ids: string[]
  /** Items matched by their place alone, sharing no value with any ancestor item left in the gap. */
  byPlace: Set<number>
  /**
   * An item under a stale key is left unpaired beside ancestor items still unmatched: it is one
   * of them, or new, but not clearly which. It is named new.
   */
  unsure: boolean
}

/**
 * Each item of `items`' identity: the key of the ancestor item it is, or for an item new on this
 * side an identity of its own. `ancestorKeys` are the ancestor's items' keys as a read gives them.
 * An item with a key of its own is named by the key a read gives it: that key the first time the
 * list holds it, else a hash of its content. A name the ancestor's read gave, or another key a
 * read could have given an ancestor item ({@link ancestorAliases}), is that ancestor item; any
 * other key marks the item new when it was minted for it, the ancestor knows it (a copy), or the
 * ancestor's read gave it to an item of another list (`inEntry`, every key the ancestor's read
 * gives across the entry): that item moved here.
 *
 * The rest align as diff3 aligns lines: equal content in order, then equal content out of order
 * (a move), then, in each gap between two matches, by shared values and last by place
 * ({@link pairInGap}). `otherSide` is the other version's list, whose copies count as this side's.
 * Undefined when the diff ran out of time.
 */
export function alignToAncestor(
  items: readonly unknown[],
  ancestorItems: readonly unknown[],
  ancestorKeys: readonly string[],
  side: string,
  inEntry: ReadonlySet<string>,
  movedIn: ReadonlySet<string>,
  otherSide: readonly unknown[] = [],
): Alignment | undefined {
  const known = new Set(ancestorKeys)
  const aliases = ancestorAliases(ancestorItems, ancestorKeys)
  const readKeys = itemKeysAsRead(items)
  const ids: Array<string | undefined> = items.map(() => undefined)
  const taken = new Set<string>()
  const minted = new Set<number>()
  // Items whose key the ancestor no longer knows, by how they may still find their item.
  const byContent = new Set<number>()
  const stale = new Set<number>()
  // A read keys an item by content (twins as K, K-2, ...), and a git-level merge bringing in the
  // base's edit of one twin leaves its key on the edited copy, which the ancestor then reads, or a
  // backfill keys, as another item's. So an item under a read key holding the item it names is
  // that item, and one holding exactly another ancestor item no key on this side names is that
  // one (an item a key names gives way only to one under its read key): also, with no git-level
  // merge, an item a side edited to read exactly like one it deleted. A moved key names its item.
  const held = new Set([...movedIn, ...items.flatMap((item) => ownKey(item) ?? [])])
  const unheld = new Map<string, number>()
  const unheldFresh = new Set<string>()
  ancestorItems.forEach((item, i) => {
    if (held.has(ancestorKeys[i])) return
    const token = valueToken(item)
    unheld.set(token, (unheld.get(token) ?? 0) + 1)
    if (!isMinted(item)) unheldFresh.add(token)
  })
  const at = new Map(ancestorKeys.map((key, i) => [key, i]))
  // Content a copy holds, under a key minted for it that the ancestor doesn't know.
  const copies = (list: readonly unknown[]) =>
    new Set(
      list.flatMap((item) => {
        const own = ownKey(item)
        return own !== undefined && !hasContentKeyShape(own) && !known.has(own)
          ? [valueToken(item)]
          : []
      }),
    )
  const [copied, otherCopied] = [copies(items), copies(otherSide)]
  // The other side's copy counts where it holds the same rewrite, so both read that item alike.
  const otherHolds = new Set(otherSide.map((item) => `${ownKey(item)}\u0000${valueToken(item)}`))
  const sameRewrite = (j: number, own: string) =>
    otherHolds.has(`${own}\u0000${valueToken(items[j])}`)
  // Whether the item may be the unheld item holding its content, and whether its key names another.
  const claim = (j: number, own: string): 'named' | 'keyed' | 'unnamed' | undefined => {
    if (!hasContentKeyShape(own)) return undefined
    const content = valueToken(items[j])
    const holders = unheld.get(content) ?? 0
    if (holders === 0) return undefined
    const read = readKeys[j]
    const named = read !== undefined && known.has(read) ? read : aliases.get(own)
    const i = named === undefined ? undefined : at.get(named)
    // A key that has gone stale on both sides is history, not content: it names its item.
    if (i !== undefined) {
      if (isMinted(ancestorItems[i]) && isMinted(items[j])) return undefined
      // A key takes only an unheld item still under its read key: one gone stale was edited.
      if (!unheldFresh.has(content)) return undefined
      // With a copy of the item its key names beside it, the side rewrote that item: read by key.
      const was = valueToken(ancestorItems[i])
      if (was === content) return undefined
      return copied.has(was) || (otherCopied.has(was) && sameRewrite(j, own)) ? 'keyed' : 'named'
    }
    // A key naming no item here pairs by content only where one item holds it, twins by place.
    return holders === 1 ? 'unnamed' : undefined
  }
  const claims = items.map((item, j) => {
    const own = ownKey(item)
    return own === undefined ? undefined : claim(j, own)
  })
  const claimants = new Map<string, number>()
  claims.forEach((c, j) => {
    const content = valueToken(items[j])
    if (c !== undefined) claimants.set(content, (claimants.get(content) ?? 0) + 1)
  })
  // More claimants than holders can't all be those items: one a key names is that item instead.
  const usurped = (j: number): boolean => {
    const content = valueToken(items[j])
    if (claims[j] !== 'named') return claims[j] === 'unnamed'
    return (claimants.get(content) ?? 0) <= (unheld.get(content) ?? 0)
  }
  items.forEach((item, j) => {
    const own = ownKey(item)
    const read = readKeys[j]
    if (own !== undefined && usurped(j)) {
      minted.add(j)
      byContent.add(j)
      stale.add(j)
      return
    }
    // A keyless item's read key is a hash of its content, which repeats among identical items:
    // those align by content and order below, never by the hash.
    const id =
      own === undefined
        ? undefined
        : read !== undefined && known.has(read)
          ? read
          : !known.has(own)
            ? aliases.get(own)
            : undefined
    if (id !== undefined && !taken.has(id)) {
      ids[j] = id
      taken.add(id)
    } else if (
      own !== undefined &&
      read !== undefined &&
      !known.has(own) &&
      hasMachineKeyShape(own) &&
      inEntry.has(read) &&
      !(hasContentKeyShape(own) && (unheld.get(valueToken(item)) ?? 0) > 0)
    ) {
      // An ancestor item of another list, moved here with its key: new to this list. Not under a
      // read key holding exactly an item of this list no key here names: a reworded twin.
      minted.add(j)
    } else if (own !== undefined && !known.has(own) && isMinted(item)) {
      // A key the ancestor doesn't know: minted for a new item, stripped there by hand, or a read
      // key for content a sync has since replaced with the base's edit (`stale`). See below.
      minted.add(j)
      byContent.add(j)
      if (hasContentKeyShape(own)) stale.add(j)
    } else if (own !== undefined && (known.has(own) || isMinted(item))) {
      minted.add(j)
    }
  })
  const match = (j: number, i: number) => {
    ids[j] = ancestorKeys[i]
    taken.add(ancestorKeys[i])
  }
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
  for (const [i, j] of anchors) if (ids[j] === undefined) match(j, i)
  // An item whose content an unmatched ancestor item has, out of order: it was moved.
  const unmatched = new Map<string, number[]>()
  ancestorItems.forEach((item, i) => {
    if (taken.has(ancestorKeys[i])) return
    const token = valueToken(item)
    unmatched.set(token, [...(unmatched.get(token) ?? []), i])
  })
  items.forEach((item, j) => {
    if (ids[j] !== undefined || minted.has(j)) return
    const i = unmatched.get(valueToken(item))?.shift()
    if (i !== undefined) match(j, i)
  })
  // Such an item is the ancestor item holding its content, or for a stale key the one holding
  // most of its values; never one under a key minted for it, though one under a read key gone
  // stale may. Only a stale key may still pair by place.
  const candidates = ancestorItems.flatMap((item, i) =>
    taken.has(ancestorKeys[i]) || (isMinted(item) && !hasContentKeyShape(ancestorKeys[i]))
      ? []
      : [i],
  )
  const open = (i: number) => !taken.has(ancestorKeys[i])
  for (const j of byContent) {
    const i = candidates.find(
      (k) => open(k) && valueToken(ancestorItems[k]) === valueToken(items[j]),
    )
    if (i !== undefined) match(j, i)
  }
  // By values only with one clear match holding most of what it held, and never for content an
  // item of another list holds exactly: that item moved here.
  const byValues = valueIndex(candidates, ancestorItems)
  for (const j of stale) {
    if (ids[j] !== undefined) continue
    const content = itemKeysAsRead([withoutOwnKey(items[j] as Record<string, unknown>)])[0]
    if (content !== undefined && !known.has(content) && inEntry.has(content)) {
      stale.delete(j)
      continue
    }
    const i = byValues.clear(items[j], open)
    if (i !== undefined) match(j, i)
  }
  const bounds: Array<[number, number]> = [
    [-1, -1],
    ...anchors,
    [ancestorItems.length, items.length],
  ]
  const byPlace = new Set<number>()
  for (let n = 0; n + 1 < bounds.length; n++) {
    const ancestorGap: number[] = []
    const sideGap: number[] = []
    for (let i = bounds[n][0] + 1; i < bounds[n + 1][0]; i++) {
      if (!taken.has(ancestorKeys[i])) ancestorGap.push(i)
    }
    for (let j = bounds[n][1] + 1; j < bounds[n + 1][1]; j++) {
      if (ids[j] === undefined && (!minted.has(j) || stale.has(j))) sideGap.push(j)
    }
    // A keyless item holding an ancestor item of another list exactly may have moved here: it
    // pairs only by its values, never by place.
    const movedHere = (j: number) => {
      const read = readKeys[j]
      return read !== undefined && !known.has(read) && inEntry.has(read)
    }
    // An item under a stale key existed before, so it may still pair by place, never by values.
    const placeOnly = (j: number) => stale.has(j)
    const paired = pairInGap(sideGap, items, ancestorGap, ancestorItems, movedHere, placeOnly)
    for (const [j, i, place] of paired) {
      match(j, i)
      if (place) byPlace.add(j)
    }
  }
  // An ancestor item under a stale key of its own is one a side may hold under another.
  const unmatched_ = ancestorItems.some(
    (item, i) =>
      !taken.has(ancestorKeys[i]) && (!isMinted(item) || hasContentKeyShape(ancestorKeys[i])),
  )
  const unsure = unmatched_ && [...stale].some((j) => ids[j] === undefined)
  return { ids: ids.map((id, j) => id ?? newIdentity(side, j)), byPlace, unsure }
}

/** Above this many value matches counted in one gap, its items pair by place or not at all. */
const MAX_SCORE_STEPS = 1_000_000

/** `item`'s content members: a block's data inside its `value`, never its key or template. */
const contentMembers = (item: unknown): Array<[string, unknown]> => {
  if (!isPlainRecord(item)) return []
  const data = typeof item.template === 'string' && isPlainRecord(item.value) ? item.value : item
  return Object.entries(data).filter(
    ([name, value]) => name !== ITEM_KEY && !isBlockStructuralKey(name) && !isEmptyValue(value),
  )
}

/**
 * Pairs a gap's side items with its ancestor items: each with the one holding most of its values,
 * the earliest on a tie. When as many are left on both sides, they pair in order by place (`true`):
 * only keyless items that did not come from another list (`movedHere`), and only with ancestor
 * items not carrying a key minted for them. The rest are adds and removes, so a delete and an add
 * in one place never read as an edit.
 */
function pairInGap(
  sideGap: readonly number[],
  items: readonly unknown[],
  ancestorGap: readonly number[],
  ancestorItems: readonly unknown[],
  movedHere: (j: number) => boolean,
  placeOnly: (j: number) => boolean,
): Array<[number, number, boolean]> {
  const index = valueIndex(ancestorGap, ancestorItems)
  const free = new Set(ancestorGap)
  const pairs: Array<[number, number, boolean]> = []
  const unpaired: number[] = []
  for (const j of sideGap) {
    if (placeOnly(j)) {
      unpaired.push(j)
      continue
    }
    const best = index.best(items[j], (i) => free.has(i))
    if (index.overBudget()) return byPlace(sideGap, ancestorGap, items, ancestorItems)
    if (best === undefined) {
      // An item with a key of its own that keeps no value of any is not one of them.
      if (ownKey(items[j]) === undefined && !movedHere(j)) unpaired.push(j)
      continue
    }
    free.delete(best)
    pairs.push([j, best, false])
  }
  // An ancestor item with a key minted for it is that item only under the key.
  const left = [...free].filter((i) => !isMinted(ancestorItems[i])).sort((x, y) => x - y)
  if (left.length === unpaired.length) unpaired.forEach((j, k) => pairs.push([j, left[k], true]))
  return pairs
}

/**
 * The ancestor items at `indices` indexed by their member values: `best(item, open)` is the open
 * one holding most of `item`'s values, the earliest on a tie, or undefined when none holds any.
 * Each value `best` matches counts against {@link MAX_SCORE_STEPS}, past which `overBudget()` is
 * true.
 */
function valueIndex(indices: readonly number[], ancestorItems: readonly unknown[]) {
  const holders = new Map<string, number[]>()
  for (const i of indices) {
    for (const [name, value] of contentMembers(ancestorItems[i])) {
      const at = `${name}\u0000${valueToken(value)}`
      holders.set(at, [...(holders.get(at) ?? []), i])
    }
  }
  let steps = 0
  return {
    best(item: unknown, open: (i: number) => boolean): number | undefined {
      const scores = new Map<number, number>()
      for (const [name, value] of contentMembers(item)) {
        for (const i of holders.get(`${name}\u0000${valueToken(value)}`) ?? []) {
          steps++
          if (open(i)) scores.set(i, (scores.get(i) ?? 0) + 1)
        }
      }
      let best: number | undefined
      let bestScore = 0
      for (const [i, score] of scores) {
        if (score > bestScore || (score === bestScore && best !== undefined && i < best)) {
          ;[best, bestScore] = [i, score]
        }
      }
      return best
    },
    /** `best`, when no other open item holds as many, and those are over half of its own values. */
    clear(item: unknown, open: (i: number) => boolean): number | undefined {
      const scores = new Map<number, number>()
      for (const [name, value] of contentMembers(item)) {
        for (const i of holders.get(`${name}\u0000${valueToken(value)}`) ?? []) {
          if (open(i)) scores.set(i, (scores.get(i) ?? 0) + 1)
        }
      }
      const ranked = [...scores].sort(([, x], [, y]) => y - x)
      const [first, second] = ranked
      if (!first || (second && second[1] === first[1])) return undefined
      return first[1] * 2 > contentMembers(ancestorItems[first[0]]).length ? first[0] : undefined
    },
    overBudget: () => steps > MAX_SCORE_STEPS,
  }
}

/** A gap too large to score: pairs as `pairInGap`'s by-place step does, from the start. */
function byPlace(
  sideGap: readonly number[],
  ancestorGap: readonly number[],
  items: readonly unknown[],
  ancestorItems: readonly unknown[],
): Array<[number, number, boolean]> {
  const side = sideGap.filter((j) => ownKey(items[j]) === undefined)
  const ancestor = ancestorGap.filter((i) => !isMinted(ancestorItems[i]))
  return side.length === ancestor.length ? side.map((j, k) => [j, ancestor[k], true]) : []
}

/** The identity of the `j`th item of `side`'s list, new on that side. */
const newIdentity = (side: string, j: number): string => `${INTERNAL}${side}${j}`

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
  // The same key as a read gives it: a key both added, or a repeat both added alike.
  const [baseRead, branchRead] = [itemKeysAsRead(baseItems), itemKeysAsRead(branchItems)]
  const branchByKey = new Map<string, number>()
  for (const j of branchNew) {
    const key = branchRead[j]
    if (key !== undefined && !branchByKey.has(key)) branchByKey.set(key, j)
  }
  for (const j of baseNew) {
    const key = baseRead[j]
    const match = key === undefined ? undefined : branchByKey.get(key)
    if (match !== undefined && !pairedBranch.has(match)) {
      baseIds[j] = branchIds[match]
      pairedBase.add(j)
      pairedBranch.add(match)
    }
  }
  // Equal content pairs two additions, unless both carry minted keys: two items reading alike.
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
