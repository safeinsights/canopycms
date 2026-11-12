/**
 * Three-way merge of one entry, field by field: the version the branch started from (ancestor),
 * the base branch's version now (base), and the branch's own (branch). A value changed on one side
 * takes that change; a value changed alike on both takes it once; a value changed differently on
 * both is a conflict, and the merged entry holds the branch's value there until a person chooses.
 *
 * Pure and client-safe. Schema-light: the input is the RAW parsed data (`parseEntryParts`), never
 * filtered by a schema, so a key the schema doesn't know merges like any other and a base's schema
 * migration survives. The schema, when given, only names conflicts as the "Show changes" drawer
 * names its changes.
 */

import type { ContentFormat, FieldConfig } from '../config'
import type { DataPathSegment } from '../editor/entry-diff'
import { ITEM_KEY, isItemKey, itemKeysAsRead } from '../item-keys'
import { findBodyFieldName } from '../utils/body-field'
import { entryAsRead } from '../utils/calendar-day'
import { parseMarkdownBody } from '../utils/markdown-parse'
import { isPlainRecord } from '../validation/field-traversal'
import { describePath, type RawSegment } from './conflict-path'
import { diff3Regions } from './diff3'
import { alignToAncestor, isNewIdentity, mergeOrder, pairNewItems } from './list-alignment'
import { mergeText, type TextConflictRegion } from './text-merge'
import { exactToken, isEmptyValue, sameValue, valueToken } from './value-equality'

/** One version of an entry: its raw data, its md/mdx body, and its entry type (from its name). */
export interface MergeSide {
  data: Record<string, unknown>
  body?: string
  entryType?: string
}

export interface EntryMergeInput {
  format: ContentFormat
  ancestor: MergeSide
  base: MergeSide
  branch: MergeSide
  /** The branch's entry type's fields, when the caller has them. */
  fields?: readonly FieldConfig[]
}

/**
 * - `changed`: changed differently on both sides, or added on both with different values;
 * - `removed-on-base`: the base removed it and the branch changed it;
 * - `removed-by-you`: the branch removed it and the base changed it.
 */
export type FieldConflictKind = 'changed' | 'removed-on-base' | 'removed-by-you'

export interface FieldConflict {
  /** The drawer's `EntryChange.key` for this place: list items named by key. */
  key: string
  dataPath: DataPathSegment[]
  /**
   * Where each version holds this place, as a read of that version names it: a list item the merge
   * paired with another side's can read under another key there, as one in a list a side left
   * keyless does. Absent for a version without the place.
   */
  sidePaths: SidePaths
  kind: FieldConflictKind
  /** A whole list item or block, rather than a field's value. */
  item?: true
  /** Each version's value; absent where that version doesn't have it. */
  ancestor?: unknown
  base?: unknown
  branch?: unknown
  /** Long text: the regions both sides changed; the rest of the text merged. */
  regions?: TextConflictRegion[]
  /** The line merge of an mdx body or field did not parse, so the whole value is the conflict. */
  unparseable?: true
}

/** Each version's own data path to a place. */
export interface SidePaths {
  ancestor?: DataPathSegment[]
  base?: DataPathSegment[]
  branch?: DataPathSegment[]
}

/**
 * A list item whose key the merge changed from the branch's to the base's: the branch's comment
 * threads that name `from` inside the items `within` (the branch's keys, outermost first) now
 * name `to`.
 */
export interface KeyRemap {
  within: string[]
  from: string
  to: string
}

export type EntryMergeResult =
  | {
      kind: 'merged'
      data: Record<string, unknown>
      body?: string
      conflicts: FieldConflict[]
      keyRemaps: KeyRemap[]
    }
  /** The entry type changed on one side and the content on the other: no field merge applies. */
  | { kind: 'entry-conflict'; reason: 'entry-type' }

/** The three versions of one value. */
interface Versions {
  o: unknown
  a: unknown
  b: unknown
}

/** Each version's own path to a place, by its own list positions; absent where it lacks it. */
interface Places {
  o?: RawSegment[]
  a?: RawSegment[]
  b?: RawSegment[]
}

type RawConflict = Omit<FieldConflict, 'key' | 'dataPath' | 'sidePaths'> & {
  at: RawSegment[]
  places: Places
  /** Each step's places, as `trail` holds each step's versions. */
  placeTrail?: Places[]
  /** Each step's versions, so a conflict can be lifted to an enclosing value. */
  trail?: Versions[]
}

interface At {
  segments: RawSegment[]
  places: Places
  /** `places` after each step of `segments`: a side keeps its place up to an item it lacks. */
  placeTrail: Places[]
  /** The versions of the value at each step of `segments`. */
  trail: Versions[]
  /** The branch's keys of the list items enclosing this place, as a read gives them. */
  branchKeys: string[]
  /** The base's and the branch's values here as a read gives them, which name list items. */
  asRead: { a: unknown; b: unknown }
  /** This place is a list item. */
  item: boolean
}

/** A line merge of a string member, kept so a schema-aware check can undo it afterwards. */
interface TextMerge {
  at: RawSegment[]
  places: Places
  placeTrail: Places[]
  versions: { o: unknown; a: string; b: string }
  conflict?: RawConflict
}

interface Walk {
  conflicts: RawConflict[]
  keyRemaps: KeyRemap[]
  /** Remaps to an item the merged entry holds without a key, named once it reads. */
  pendingRemaps: Array<{ at: RawSegment[]; within: string[]; from: string }>
  texts: TextMerge[]
  /** Every key the ancestor's read gives its list items, across the entry. */
  ancestorKeys: ReadonlySet<string>
  /**
   * True when the branch holds `key` inside enclosing items `within` in more than one list. A
   * remap names an item by those alone, so it would move the other list's threads too, maybe
   * onto another item: none is recorded, and a thread whose key changes is orphaned instead.
   */
  ambiguous: (within: readonly string[], key: string) => boolean
}

const ROOT: At = {
  segments: [],
  places: { o: [], a: [], b: [] },
  placeTrail: [],
  trail: [],
  branchKeys: [],
  item: false,
  asRead: { a: undefined, b: undefined },
}

/** `places` one step on: `step` gives each side's segment, or none where that side lacks it. */
const placesOn = (places: Places, step: (side: keyof Places) => RawSegment | undefined): Places => {
  const on = (side: keyof Places) => {
    const segment = step(side)
    const place = places[side]
    return place && segment ? [...place, segment] : undefined
  }
  return { o: on('o'), a: on('a'), b: on('b') }
}

const child = (at: At, segment: RawSegment, versions: Versions): At => {
  const inside = (v: unknown) =>
    'field' in segment && isPlainRecord(v) ? member(v, segment.field) : undefined
  const places = placesOn(at.places, () => segment)
  return {
    segments: [...at.segments, segment],
    places,
    placeTrail: [...at.placeTrail, places],
    trail: [...at.trail, versions],
    branchKeys: at.branchKeys,
    item: false,
    asRead: { a: inside(at.asRead.a), b: inside(at.asRead.b) },
  }
}

/** `record`'s own member `name`: never one it inherits, and `__proto__` as a member. */
const member = (record: Record<string, unknown>, name: string): unknown =>
  Object.getOwnPropertyDescriptor(record, name)?.value

/** Sets `name` as an own member, so `__proto__` is a member like any other. */
const setMember = (record: Record<string, unknown>, name: string, value: unknown): void => {
  Object.defineProperty(record, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

const isRecordList = (value: unknown): value is unknown[] =>
  Array.isArray(value) && value.every(isPlainRecord)

/** A list of plain values (tags): no records or lists inside, which merge only as a whole. */
const isPlainList = (value: unknown): value is unknown[] =>
  Array.isArray(value) && !value.some((v) => isPlainRecord(v) || Array.isArray(v))

const asList = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])

const usableKey = (item: unknown): string | undefined =>
  isPlainRecord(item) && isItemKey(item[ITEM_KEY]) ? item[ITEM_KEY] : undefined

const versions = (o: unknown, a: unknown, b: unknown) => ({
  ...(o !== undefined && { ancestor: o }),
  ...(a !== undefined && { base: a }),
  ...(b !== undefined && { branch: b }),
})

/** A block item whose template one side changed: the whole item is one value. */
const templateChanged = (o: unknown, a: unknown, b: unknown): boolean => {
  const discriminator = (v: unknown, key: string) => (isPlainRecord(v) ? v[key] : undefined)
  return ['template', '_type'].some(
    (key) =>
      discriminator(o, key) !== discriminator(a, key) ||
      discriminator(o, key) !== discriminator(b, key),
  )
}

const kindOf = (a: unknown, b: unknown): FieldConflictKind =>
  isEmptyValue(a) ? 'removed-on-base' : isEmptyValue(b) ? 'removed-by-you' : 'changed'

function conflict(o: unknown, a: unknown, b: unknown, at: At, walk: Walk): void {
  walk.conflicts.push({
    at: at.segments,
    places: at.places,
    placeTrail: at.placeTrail,
    trail: at.trail,
    kind: kindOf(a, b),
    ...(at.item && { item: true as const }),
    ...versions(o, a, b),
  })
}

/**
 * Records and lists always merge member by member and item by item, even where two sides compare
 * equal: equality ignores item keys, and taking one side's whole record or list would drop the
 * keys the other side's items carry, and the comment threads anchored on them.
 */
function mergeValue(o: unknown, a: unknown, b: unknown, at: At, walk: Walk) {
  const absentOrEmpty = o === undefined || isEmptyValue(o)
  if (isPlainRecord(a) && isPlainRecord(b) && (isPlainRecord(o) || absentOrEmpty)) {
    if (!(at.item && templateChanged(o, a, b))) return mergeRecord(o, a, b, at, walk)
  } else if (isRecordList(a) && isRecordList(b) && (isRecordList(o) || absentOrEmpty)) {
    const merged = mergeList(o, a, b, at, walk)
    if (merged) return merged
  }
  return mergeLeaf(o, a, b, at, walk)
}

/**
 * A side left exactly as the ancestor had it yields to the other side, byte for byte, before any
 * looser equality decides, so `merge(O, A, O)` is A and `merge(O, O, B)` is B.
 */
function mergeLeaf(o: unknown, a: unknown, b: unknown, at: At, walk: Walk): unknown {
  if (exactToken(o) === exactToken(b)) return a
  if (exactToken(o) === exactToken(a) || sameValue(a, b) || sameValue(o, a)) return b
  if (sameValue(o, b)) return a
  const empty = o === undefined || isEmptyValue(o)
  if (isPlainList(a) && isPlainList(b) && (isPlainList(o) || empty)) {
    const merged = mergeScalarList(asList(o), a, b)
    if (merged) return merged
  } else if (
    typeof a === 'string' &&
    typeof b === 'string' &&
    (typeof o === 'string' || empty) &&
    `${typeof o === 'string' ? o : ''}${a}${b}`.includes('\n')
  ) {
    const merged = mergeText(typeof o === 'string' ? o : '', a, b)
    if (merged) {
      const text: TextMerge = {
        at: at.segments,
        places: at.places,
        placeTrail: at.placeTrail,
        versions: { o, a, b },
      }
      if (merged.regions.length > 0) {
        text.conflict = {
          at: at.segments,
          places: at.places,
          placeTrail: at.placeTrail,
          trail: at.trail,
          kind: 'changed',
          ...versions(o, a, b),
          regions: merged.regions,
        }
        walk.conflicts.push(text.conflict)
      }
      walk.texts.push(text)
      return merged.text
    }
  }
  conflict(o, a, b, at, walk)
  return b
}

/**
 * diff3 over a list of plain values (tags). Values both sides inserted at the same place are all
 * kept ({@link insertedByBoth}), since an insertion loses nothing; any other overlap is undefined,
 * a whole-field conflict.
 */
function mergeScalarList(
  o: readonly unknown[],
  a: readonly unknown[],
  b: readonly unknown[],
): unknown[] | undefined {
  const lists = { ancestor: o, base: a, branch: b }
  const [oT, aT, bT] = [o, a, b].map((list) => list.map(valueToken))
  const regions = diff3Regions(oT, aT, bT)
  if (!regions) return undefined
  const out: unknown[] = []
  for (const region of regions) {
    if (region.stable) {
      out.push(...lists[region.side].slice(...region.span))
      continue
    }
    const [aPart, bPart] = [a.slice(...region.base), b.slice(...region.branch)]
    const [aTokens, bTokens] = [aT.slice(...region.base), bT.slice(...region.branch)]
    if (aTokens.length === bTokens.length && aTokens.every((t, n) => t === bTokens[n])) {
      out.push(...bPart)
    } else if (region.ancestor[0] === region.ancestor[1]) {
      out.push(...insertedByBoth(aPart, aTokens, bPart, bTokens))
    } else {
      return undefined
    }
  }
  return withoutExtraRepeats(out, a, b)
}

/**
 * `merged` holding each value no more often than the side holding it most: a value both sides
 * added at different places is one value, at the first place.
 */
function withoutExtraRepeats(
  merged: readonly unknown[],
  a: readonly unknown[],
  b: readonly unknown[],
): unknown[] {
  const count = (list: readonly unknown[]) => {
    const counts = new Map<string, number>()
    for (const v of list) counts.set(valueToken(v), (counts.get(valueToken(v)) ?? 0) + 1)
    return counts
  }
  const [inA, inB] = [count(a), count(b)]
  const kept = new Map<string, number>()
  return merged.filter((v) => {
    const token = valueToken(v)
    const n = (kept.get(token) ?? 0) + 1
    kept.set(token, n)
    return n <= Math.max(inA.get(token) ?? 0, inB.get(token) ?? 0)
  })
}

/** True when `x` appears in `y` in order, not necessarily side by side. */
const isSubsequence = (x: readonly string[], y: readonly string[]): boolean => {
  let n = 0
  for (const token of y) if (token === x[n]) n++
  return n === x.length
}

/**
 * Values both sides inserted at one place: the side whose insert holds the other's in order,
 * else the base's then the branch's, each repeat of a base value counted once.
 */
function insertedByBoth(
  aPart: readonly unknown[],
  aTokens: readonly string[],
  bPart: readonly unknown[],
  bTokens: readonly string[],
): unknown[] {
  if (isSubsequence(aTokens, bTokens)) return [...bPart]
  if (isSubsequence(bTokens, aTokens)) return [...aPart]
  const fromBase = new Map<string, number>()
  for (const token of aTokens) fromBase.set(token, (fromBase.get(token) ?? 0) + 1)
  const rest = bPart.filter((_, n) => {
    const left = fromBase.get(bTokens[n]) ?? 0
    if (left === 0) return true
    fromBase.set(bTokens[n], left - 1)
    return false
  })
  return [...aPart, ...rest]
}

function mergeRecord(
  o: unknown,
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  at: At,
  walk: Walk,
): Record<string, unknown> {
  const ancestor = isPlainRecord(o) ? o : {}
  const out: Record<string, unknown> = {}
  for (const name of new Set([...Object.keys(b), ...Object.keys(a), ...Object.keys(ancestor)])) {
    if (name === ITEM_KEY) continue
    const [om, am, bm] = [member(ancestor, name), member(a, name), member(b, name)]
    const v = mergeValue(om, am, bm, child(at, { field: name }, { o: om, a: am, b: bm }), walk)
    if (v !== undefined) setMember(out, name, v)
  }
  // A list item's key is chosen by its list; any other record's is carried.
  const key = member(b, ITEM_KEY) ?? member(a, ITEM_KEY)
  if (!at.item && key !== undefined) setMember(out, ITEM_KEY, key)
  return out
}

/**
 * Items are matched across the three versions by identity (`list-alignment.ts`), merged item by
 * item, and ordered by `mergeOrder`. A matched item takes the base's key, else, when the base
 * changed it, the key the base's version reads under, else the branch's: the merged file converges
 * on the base's keys. An item neither side keyed gets no key. An item
 * removed on one side and changed on the other is an item conflict, and the branch's state holds.
 */
function mergeList(
  o: unknown,
  a: readonly unknown[],
  b: readonly unknown[],
  at: At,
  walk: Walk,
  namedBy?: string,
): unknown[] | undefined {
  const O = asList(o)
  const identities =
    namedBy === undefined
      ? identifyByKey(O, a, b, walk.ancestorKeys)
      : identifyByName(O, a, b, namedBy)
  // A list too far apart to align in time, or whose items can't all be told apart, is one value.
  // So is one with an item not clearly new or old, unless the other side holds the ancestor's
  // items as they were: that side is the ancestor item for item, and the changed side's list is
  // the merge whichever the item is.
  if (!identities) return undefined
  let { aIds, bIds, aByPlace, bByPlace } = identities
  const { oKeys } = identities
  if (identities.unsure) {
    // By place, unless a key the side holds names another ancestor item: alike items reordered.
    const asAncestor = (side: readonly unknown[]) =>
      side.length === O.length &&
      sameValue(O, side) &&
      side.every((item, n) => {
        const key = usableKey(item)
        return key === undefined || key === oKeys[n] || !oKeys.includes(key)
      })
    if (asAncestor(a)) [aIds, aByPlace] = [oKeys, new Set()]
    else if (asAncestor(b)) [bIds, bByPlace] = [oKeys, new Set()]
    else return undefined
  }
  const readList = (v: unknown, raw: readonly unknown[]) =>
    Array.isArray(v) && v.length === raw.length ? v : raw
  const [aRead, bRead] = [readList(at.asRead.a, a), readList(at.asRead.b, b)]
  const [aReadKeys, bReadKeys] = [itemKeysAsRead(aRead), itemKeysAsRead(bRead)]
  const held = new Set([...a, ...b].flatMap((item) => usableKey(item) ?? []))
  const index = (ids: readonly string[]) => new Map(ids.map((id, n) => [id, n]))
  const [oAt, aAt, bAt] = [index(oKeys), index(aIds), index(bIds)]
  const used = new Set<string>()
  const out: unknown[] = []

  for (const id of mergeOrder(oKeys, aIds, bIds)) {
    const i = isNewIdentity(id) ? undefined : oAt.get(id)
    const ja = aAt.get(id)
    const jb = bAt.get(id)
    const [oi, ai, bi] = [
      i === undefined ? undefined : O[i],
      ja === undefined ? undefined : a[ja],
      jb === undefined ? undefined : b[jb],
    ]
    const itemVersions = { o: oi, a: ai, b: bi }
    const itemPlaces = placesOn(at.places, (side) => {
      const index = { o: i, a: ja, b: jb }[side]
      return index === undefined ? undefined : { index }
    })
    const itemAt: At = {
      segments: [...at.segments, { index: out.length }],
      places: itemPlaces,
      placeTrail: [...at.placeTrail, itemPlaces],
      trail: [...at.trail, itemVersions],
      branchKeys: [...at.branchKeys, (jb !== undefined && bReadKeys[jb]) || id],
      item: true,
      asRead: {
        a: ja === undefined ? undefined : aRead[ja],
        b: jb === undefined ? undefined : bRead[jb],
      },
    }
    if (i !== undefined && ja === undefined && jb === undefined) continue
    if (i !== undefined && ja === undefined) {
      if (sameValue(oi, bi)) continue
      conflict(oi, ai, bi, itemAt, walk)
    } else if (i !== undefined && jb === undefined) {
      if (sameValue(oi, ai)) continue
      // Named as the drawer names it once the merge lands, comparing the base with the branch:
      // by the key the base's version reads under.
      const named = (ja !== undefined && aReadKeys[ja]) || id
      conflict(oi, ai, bi, { ...itemAt, segments: [...at.segments, { item: named }] }, walk)
      continue
    }
    if (ja === undefined || jb === undefined) {
      out.push(ja === undefined ? bi : ai)
      continue
    }
    // Matched by place alone, it may be another item: one side's change stands whole, two conflict.
    const placeOnly = aByPlace.has(ja) || bByPlace.has(jb)
    if (placeOnly && !sameValue(ai, bi)) {
      const [aChanged, bChanged] = [!sameValue(oi, ai), !sameValue(oi, bi)]
      if (aChanged && bChanged) conflict(oi, ai, bi, itemAt, walk)
      // The base's item stands in the branch's place: the branch's threads follow it there.
      const from = bReadKeys[jb]
      if (aChanged && !bChanged && from !== undefined && !walk.ambiguous(at.branchKeys, from)) {
        walk.pendingRemaps.push({ at: itemAt.segments, within: at.branchKeys, from })
      }
      out.push(aChanged && !bChanged ? ai : bi)
      continue
    }
    const merged = mergeValue(oi, ai, bi, itemAt, walk)
    // A keyless item the base changed takes the key the base's version reads under, which the
    // next sync's ancestor names it by, never the branch's read key for content it no longer has.
    // Never onto a key another item of either version holds as its own, nor for a branch key that
    // names items in two lists alike: a remap could not tell them apart (see Walk.ambiguous).
    const baseKey = aReadKeys[ja]
    const rekey =
      oi !== undefined &&
      usableKey(bi) !== undefined &&
      !sameValue(oi, ai) &&
      baseKey !== undefined &&
      (!held.has(baseKey) || baseKey === usableKey(bi)) &&
      (bReadKeys[jb] === undefined || !walk.ambiguous(at.branchKeys, bReadKeys[jb]))
    const keys = { base: rekey ? baseKey : undefined, branchRead: bReadKeys[jb] }
    const keyed = withListKey(merged, ai, bi, keys, used, at, walk)
    // An item left with no key reads under a hash of its merged content: the branch's threads
    // follow it there, once the merged entry reads.
    if (
      usableKey(keyed) === undefined &&
      keys.branchRead !== undefined &&
      !walk.ambiguous(at.branchKeys, keys.branchRead)
    ) {
      walk.pendingRemaps.push({ at: itemAt.segments, within: at.branchKeys, from: keys.branchRead })
    }
    out.push(keyed)
  }
  return out
}

function identifyByKey(
  O: readonly unknown[],
  a: readonly unknown[],
  b: readonly unknown[],
  inEntry: ReadonlySet<string>,
) {
  const oKeys = itemKeysAsRead(O).map((key, i) => key ?? `${i}`)
  const aligned = alignToAncestor(a, O, oKeys, 'a', inEntry)
  const bAligned = alignToAncestor(b, O, oKeys, 'b', inEntry)
  if (!aligned || !bAligned) return undefined
  pairNewItems(a, aligned.ids, b, bAligned.ids)
  return {
    oKeys,
    aIds: aligned.ids,
    bIds: bAligned.ids,
    aByPlace: aligned.byPlace,
    bByPlace: bAligned.byPlace,
    unsure: aligned.unsure || bAligned.unsure,
  }
}

/**
 * Identities by the string member `name`. A version with an item that has no name, or a name two
 * items share, leaves no way to tell its items apart: undefined, and the list is one value.
 */
function identifyByName(
  O: readonly unknown[],
  a: readonly unknown[],
  b: readonly unknown[],
  name: string,
) {
  const ids = (items: readonly unknown[]) => {
    const names = items.map((item) => (isPlainRecord(item) ? member(item, name) : undefined))
    const distinct = new Set(names)
    const usable = names.every((n) => typeof n === 'string' && !isNewIdentity(n))
    return usable && distinct.size === names.length ? (names as string[]) : undefined
  }
  const [oKeys, aIds, bIds] = [ids(O), ids(a), ids(b)]
  if (!oKeys || !aIds || !bIds) return undefined
  const none = new Set<number>()
  return { oKeys, aIds, bIds, aByPlace: none, bByPlace: none, unsure: false }
}

/** `merged` with the key its list gives it, recording the remap when the branch's key changes. */
function withListKey(
  merged: unknown,
  ai: unknown,
  bi: unknown,
  keys: { base: string | undefined; branchRead: string | undefined },
  used: Set<string>,
  at: At,
  walk: Walk,
): unknown {
  if (!isPlainRecord(merged)) return merged
  const branchReadKey = keys.branchRead
  const key = [usableKey(ai) ?? keys.base, usableKey(bi)].find(
    (k) => k !== undefined && !used.has(k),
  )
  if (key === undefined) {
    const carried = isPlainRecord(bi) ? bi[ITEM_KEY] : undefined
    return carried === undefined ? merged : { ...merged, [ITEM_KEY]: carried }
  }
  used.add(key)
  if (
    branchReadKey !== undefined &&
    branchReadKey !== key &&
    !walk.ambiguous(at.branchKeys, branchReadKey)
  ) {
    walk.keyRemaps.push({ within: at.branchKeys, from: branchReadKey, to: key })
  }
  return { ...merged, [ITEM_KEY]: key }
}

/** A version's data with its md/mdx body under the body field, as a read gives the form. */
const withBody = (side: MergeSide, bodyName: string): Record<string, unknown> =>
  side.body === undefined ? side.data : { ...side.data, [bodyName]: side.body }

const mdxParses = (text: string): boolean => parseMarkdownBody(text, 'mdx') !== undefined

const sameContent = (x: MergeSide, y: MergeSide): boolean =>
  sameValue(x.data, y.data) && (x.body ?? '') === (y.body ?? '')

function mergeBody(
  o: string,
  a: string,
  b: string,
  format: ContentFormat,
  at: At,
  walk: Walk,
): string {
  if (a === b || o === a) return b
  if (o === b) return a
  const merged = mergeText(o, a, b)
  if (!merged) {
    conflict(o, a, b, at, walk)
    return b
  }
  const { text, regions } = merged
  const parses = (body: string) => format !== 'mdx' || mdxParses(body)
  if (!parses(text) && parses(a) && parses(b)) {
    walk.conflicts.push({
      at: at.segments,
      places: at.places,
      kind: 'changed',
      ...versions(o, a, b),
      unparseable: true,
    })
    return b
  }
  if (regions.length > 0) {
    walk.conflicts.push({
      at: at.segments,
      places: at.places,
      kind: 'changed',
      ...versions(o, a, b),
      regions,
    })
  }
  return text
}

export function mergeEntry({
  format,
  ancestor,
  base,
  branch,
  fields,
}: EntryMergeInput): EntryMergeResult {
  if (base.entryType !== branch.entryType) {
    const baseRetyped = base.entryType !== ancestor.entryType
    const branchRetyped = branch.entryType !== ancestor.entryType
    const unchanged = baseRetyped ? branch : base
    if (baseRetyped && branchRetyped) return { kind: 'entry-conflict', reason: 'entry-type' }
    if (!sameContent(ancestor, unchanged)) return { kind: 'entry-conflict', reason: 'entry-type' }
    const retyped = baseRetyped ? base : branch
    return {
      kind: 'merged',
      data: retyped.data,
      ...(retyped.body !== undefined && { body: retyped.body }),
      conflicts: [],
      keyRemaps: [],
    }
  }
  const ancestorKeys = new Set<string>()
  visitItems(ancestor.data, (_item, key) => ancestorKeys.add(key))
  const asRead = (side: MergeSide) => (fields ? entryAsRead(fields, side.data) : side.data)
  const root = { ...ROOT, asRead: { a: asRead(base), b: asRead(branch) } }
  const walk: Walk = {
    conflicts: [],
    keyRemaps: [],
    pendingRemaps: [],
    texts: [],
    ancestorKeys,
    ambiguous: ambiguityOf(root.asRead.b, fields !== undefined),
  }
  const data = mergeRecord(ancestor.data, base.data, branch.data, root, walk)
  if (fields) undoUnparseableMdx(fields, data, walk)
  flagItemsMovedAway(ancestor.data, base.data, branch.data, data, walk)
  const hasBody = [ancestor, base, branch].some((side) => side.body !== undefined)
  const bodyName = findBodyFieldName(fields ?? [])
  const body = hasBody
    ? mergeBody(
        ancestor.body ?? '',
        base.body ?? '',
        branch.body ?? '',
        format,
        child(ROOT, { field: bodyName }, { o: ancestor.body, a: base.body, b: branch.body }),
        walk,
      )
    : undefined
  const read = fields ? entryAsRead(fields, data) : data
  for (const { at, within, from } of walk.pendingRemaps) {
    const last = at.at(-1)
    const list = valueAt(read, at.slice(0, -1))
    const to =
      last && 'index' in last && Array.isArray(list) ? itemKeysAsRead(list)[last.index] : undefined
    if (to !== undefined && to !== from) walk.keyRemaps.push({ within, from, to })
  }
  return {
    kind: 'merged',
    data,
    ...(body !== undefined && { body }),
    conflicts: named(walk.conflicts, fields, read, {
      o: withBody(ancestor, bodyName),
      a: withBody(base, bodyName),
      b: withBody(branch, bodyName),
    }),
    keyRemaps: walk.keyRemaps,
  }
}

/**
 * {@link Walk.ambiguous} for `branch`, as read. A schema's read keys each list a thread can name,
 * so only keyed items count; with no schema, every list's items count by their read keys.
 */
function ambiguityOf(branch: unknown, schemaRead: boolean): Walk['ambiguous'] {
  const seen = new Map<string, number>()
  const name = (within: readonly string[], key: string) => JSON.stringify([...within, key])
  const visit = (node: unknown, within: string[]) => {
    if (Array.isArray(node)) {
      const readKeys = schemaRead ? [] : itemKeysAsRead(node)
      node.forEach((item, n) => {
        const key = schemaRead ? usableKey(item) : readKeys[n]
        if (key === undefined) return
        seen.set(name(within, key), (seen.get(name(within, key)) ?? 0) + 1)
        visit(item, [...within, key])
      })
    } else if (isPlainRecord(node)) {
      for (const value of Object.values(node)) visit(value, within)
    }
  }
  visit(branch, [])
  return (within, key) => (seen.get(name(within, key)) ?? 0) > 1
}

interface KeyedItem {
  item: unknown
  /** The list holding it: field names, and each enclosing item by its key. */
  list: string
  /** Where it is in its version. */
  at: RawSegment[]
}

/**
 * Each item in `data`, at any depth, by the key a read gives it, so a keyless item is found by its
 * content; null for a key held more than once in the entry.
 */
function keyedItems(data: unknown): Map<string, KeyedItem | null> {
  const found = new Map<string, KeyedItem | null>()
  visitItems(data, (item, key, list, at) => {
    for (const name of [key, contentName(item)]) {
      found.set(name, found.has(name) ? null : { item, list, at })
    }
  })
  return found
}

/** An item's content as a name, so an item a side moved without its key is still found. */
const contentName = (item: unknown): string => `${ITEM_KEY}:${valueToken(item)}`

/** Calls `onItem` for every record in a list in `node`, with its read key, list and path. */
function visitItems(
  node: unknown,
  onItem: (item: unknown, key: string, list: string, at: RawSegment[]) => void,
  at: RawSegment[] = [],
  list = '',
): void {
  if (Array.isArray(node)) {
    const keys = itemKeysAsRead(node)
    node.forEach((item, index) => {
      const key = keys[index]
      const itemAt = [...at, { index }]
      if (key !== undefined) onItem(item, key, list, itemAt)
      visitItems(item, onItem, itemAt, `${list}[${key ?? `#${index}`}]`)
    })
  } else if (isPlainRecord(node)) {
    for (const [name, value] of Object.entries(node)) {
      visitItems(value, onItem, [...at, { field: name }], `${list}.${name}`)
    }
  }
}

/**
 * Lists merge one at a time, so an item one side moved to another list survives there although
 * the other side removed it, or is there twice when the other side changed it in its old place.
 * An item the merged entry holds in another list than the ancestor did, which a side no longer has
 * anywhere (by its key as read, so a keyless item by its content), or a keyed item the entry now
 * holds twice, is an item conflict.
 */
function flagItemsMovedAway(
  ancestor: Record<string, unknown>,
  base: Record<string, unknown>,
  branch: Record<string, unknown>,
  merged: Record<string, unknown>,
  walk: Walk,
): void {
  const [o, a, b] = [keyedItems(ancestor), keyedItems(base), keyedItems(branch)]
  const named = new Set(walk.conflicts.map((c) => JSON.stringify(c.at)))
  const seen = new Set<string>()
  visitItems(merged, (item, key, list, at) => {
    // A keyed item is found by its key alone: another item reading alike is not it. A keyless
    // one, by its content too, which finds an item a side moved without its key.
    const keyed = usableKey(item) !== undefined
    const content = contentName(item)
    const find = (found: Map<string, KeyedItem | null>) =>
      found.has(key) || keyed ? found.get(key) : found.get(content)
    const holds = (found: Map<string, KeyedItem | null>) =>
      found.has(key) || (!keyed && found.has(content))
    const [inO, inA, inB] = [find(o), find(a), find(b)]
    // A side holding it twice copied it: no move to judge.
    if (inA === null || inB === null) return
    const twice = keyed && seen.has(key)
    seen.add(key)
    const moved = inO && inO.list !== list
    const kind = twice
      ? 'changed'
      : moved && !holds(a)
        ? 'removed-on-base'
        : moved && !holds(b)
          ? 'removed-by-you'
          : undefined
    if (!kind || named.has(JSON.stringify(at))) return
    walk.conflicts.push({
      at,
      places: { o: inO?.at, a: inA?.at, b: inB?.at },
      kind,
      item: true,
      ...versions(inO?.item, inA?.item, inB?.item),
    })
  })
}

/**
 * The conflicts as the drawer names them. Where the drawer shows a whole value (an image, a field
 * the schema doesn't know) a conflict inside it is lifted to that value: its versions become the
 * whole value's, and the conflicts inside it are one. The merged entry keeps what merged there.
 */
function named(
  conflicts: readonly RawConflict[],
  fields: readonly FieldConfig[] | undefined,
  read: unknown,
  sides: Versions,
): FieldConflict[] {
  const seen = new Set<string>()
  const out: FieldConflict[] = []
  const asRead = (side: unknown) =>
    fields && isPlainRecord(side) ? entryAsRead(fields, side) : side
  const reads = { o: asRead(sides.o), a: asRead(sides.a), b: asRead(sides.b) }
  for (const { at, places, placeTrail, trail, ...rest } of conflicts) {
    const { key, dataPath, depth } = describePath(fields, read, at)
    if (seen.has(key)) continue
    seen.add(key)
    // Each version's own path to where its value below was taken: its place, or its place at the
    // step the name stops at when the merge's trail gave the whole value, or the merged path when
    // the whole value was found by member names alone. A version without the item a conflict names
    // is named by the list it holds, one step short of `dataPath`, which says it lacks the item. A
    // side naming the place at another depth offers none.
    const prefix = at.slice(0, depth)
    const byName = prefix.every((segment) => 'field' in segment)
    const placeOf = (side: keyof Places): RawSegment[] | undefined =>
      depth === at.length
        ? places[side]
        : trail?.[depth - 1]
          ? placeTrail?.[depth - 1]?.[side]
          : byName
            ? prefix
            : undefined
    const describe = (side: keyof Places, place: RawSegment[]) => {
      const named = describePath(fields, reads[side], place)
      return named.depth === place.length ? named.dataPath : undefined
    }
    const sidePath = (side: keyof Places): DataPathSegment[] | undefined => {
      const place = placeOf(side)
      if (place) return describe(side, place)
      const list =
        depth === at.length && rest.item ? placeTrail?.[at.length - 2]?.[side] : undefined
      const holder = list && describe(side, list)
      const missing = dataPath.at(-1)
      return holder && missing && 'item' in missing ? holder : undefined
    }
    const [ancestor, base, branch] = [sidePath('o'), sidePath('a'), sidePath('b')]
    const sidePaths: SidePaths = {
      ...(ancestor && { ancestor }),
      ...(base && { base }),
      ...(branch && { branch }),
    }
    if (depth === at.length) {
      out.push({ key, dataPath, sidePaths, ...rest })
      continue
    }
    // The whole value's versions: from the merge's own trail, else by member names when the way
    // there passes no list item (whose place differs between versions), else none to offer.
    const whole =
      trail?.[depth - 1] ??
      (byName
        ? { o: valueAt(sides.o, prefix), a: valueAt(sides.a, prefix), b: valueAt(sides.b, prefix) }
        : undefined)
    out.push({
      key,
      dataPath,
      sidePaths,
      kind: whole ? kindOf(whole.a, whole.b) : 'changed',
      ...(!('field' in at[depth - 1]) && { item: true as const }),
      ...(whole && versions(whole.o, whole.a, whole.b)),
    })
  }
  return out
}

/** The value at `at` in `data`. */
function valueAt(data: unknown, at: readonly RawSegment[]): unknown {
  let node = data
  for (const segment of at) {
    node =
      'index' in segment
        ? asList(node)[segment.index]
        : 'field' in segment && isPlainRecord(node)
          ? member(node, segment.field)
          : undefined
  }
  return node
}

/** The member at `at` in `data`, which the merge built along every such path, set to `value`. */
function setAt(data: Record<string, unknown>, at: readonly RawSegment[], value: unknown): void {
  const holder = valueAt(data, at.slice(0, -1))
  const last = at.at(-1)
  if (last && 'field' in last && isPlainRecord(holder)) setMember(holder, last.field, value)
}

/**
 * An `mdx` field whose line merge does not parse, where both sides' texts do: the branch's text
 * goes back in, and the whole field is one conflict, as for an mdx body.
 */
function undoUnparseableMdx(
  fields: readonly FieldConfig[],
  data: Record<string, unknown>,
  walk: Walk,
): void {
  for (const text of walk.texts) {
    if (describePath(fields, data, text.at).field?.type !== 'mdx') continue
    const { o, a, b } = text.versions
    if (mdxParses(String(valueAt(data, text.at))) || !mdxParses(a) || !mdxParses(b)) continue
    setAt(data, text.at, b)
    const whole: RawConflict = {
      at: text.at,
      places: text.places,
      placeTrail: text.placeTrail,
      trail: text.conflict?.trail,
      kind: 'changed',
      ...versions(o, a, b),
      unparseable: true,
    }
    const at = text.conflict ? walk.conflicts.indexOf(text.conflict) : -1
    if (at === -1) walk.conflicts.push(whole)
    else walk.conflicts[at] = whole
  }
}

/**
 * `a` (the base's) and `b` (the branch's), both changed from `o`, merged as ordered sets of
 * distinct values: each side's adds and removes apply, and the order is `mergeOrder`'s. Nothing
 * conflicts: a set entry has no content to change.
 */
function mergeOrderedSet(
  o: readonly unknown[],
  a: readonly unknown[],
  b: readonly unknown[],
): unknown[] {
  const ids = (list: readonly unknown[]) => [...new Set(list.map(valueToken))]
  const [oIds, aIds, bIds] = [ids(o), ids(a), ids(b)]
  const value = new Map([...o, ...a, ...b].map((v) => [valueToken(v), v]))
  const [inO, inA, inB] = [new Set(oIds), new Set(aIds), new Set(bIds)]
  return mergeOrder(oIds, aIds, bIds)
    .filter((id) => (inO.has(id) ? inA.has(id) && inB.has(id) : inA.has(id) || inB.has(id)))
    .map((id) => value.get(id))
}

/**
 * Three-way merge of a collection's `.collection.json`: `order` as an ordered set of content IDs,
 * so two branches that each add an entry both keep theirs; `entries` matched by `name`; every
 * other member by the entry rules.
 */
export function mergeCollectionMeta(
  ancestor: Record<string, unknown>,
  base: Record<string, unknown>,
  branch: Record<string, unknown>,
): { data: Record<string, unknown>; conflicts: FieldConflict[] } {
  const walk: Walk = {
    conflicts: [],
    keyRemaps: [],
    pendingRemaps: [],
    texts: [],
    ancestorKeys: new Set(),
    ambiguous: () => false,
  }
  const data: Record<string, unknown> = {}
  for (const name of new Set([
    ...Object.keys(branch),
    ...Object.keys(base),
    ...Object.keys(ancestor),
  ])) {
    const [o, a, b] = [member(ancestor, name), member(base, name), member(branch, name)]
    const at = child(ROOT, { field: name }, { o, a, b })
    const lists = [o, a, b].every((v) => v === undefined || Array.isArray(v))
    let v: unknown
    if (name === 'order' && lists && !sameValue(o, b) && !sameValue(o, a)) {
      v = mergeOrderedSet(asList(o), asList(a), asList(b))
    } else if (name === 'entries' && [o, a, b].every((x) => x === undefined || isRecordList(x))) {
      v = mergeList(o, asList(a), asList(b), at, walk, 'name') ?? mergeLeaf(o, a, b, at, walk)
    } else {
      v = mergeValue(o, a, b, at, walk)
    }
    if (v !== undefined) setMember(data, name, v)
  }
  return {
    data,
    conflicts: named(walk.conflicts, undefined, data, { o: ancestor, a: base, b: branch }),
  }
}
