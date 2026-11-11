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

import equal from 'fast-deep-equal'
import { diff3MergeRegions as diff3Regions } from 'node-diff3'

import type { ContentFormat, FieldConfig } from '../config'
import type { DataPathSegment } from '../editor/entry-diff'
import { ITEM_KEY, isItemKey, itemKeysAsRead } from '../item-keys'
import { findBodyFieldName } from '../utils/body-field'
import { entryAsRead } from '../utils/calendar-day'
import { parseMarkdownBody } from '../utils/markdown-parse'
import { isPlainRecord } from '../validation/field-traversal'
import { describePath, type RawSegment } from './conflict-path'
import {
  alignToAncestor,
  isNewIdentity,
  mergeOrder,
  newIdentity,
  pairNewItems,
} from './list-alignment'
import { mergeText, type TextConflictRegion } from './text-merge'
import { isEmptyValue, sameValue, valueToken } from './value-equality'

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
  kind: FieldConflictKind
  /** A whole list item or block, rather than a field's value. */
  item?: true
  /** Each version's value; absent where that version doesn't have it. */
  ancestor?: unknown
  base?: unknown
  branch?: unknown
  /** Long text: the regions both sides changed; the rest of the text merged. */
  regions?: TextConflictRegion[]
  /** The line merge of an mdx body did not parse, so the whole body is the conflict. */
  unparseable?: true
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

type RawConflict = Omit<FieldConflict, 'key' | 'dataPath'> & { at: RawSegment[] }

interface At {
  segments: RawSegment[]
  /** The branch's keys of the list items enclosing this place, outermost first. */
  branchKeys: string[]
  /** This place is a list item. */
  item: boolean
}

interface Walk {
  conflicts: RawConflict[]
  keyRemaps: KeyRemap[]
}

const ROOT: At = { segments: [], branchKeys: [], item: false }

const child = (at: At, segment: RawSegment): At => ({
  segments: [...at.segments, segment],
  branchKeys: at.branchKeys,
  item: false,
})

const isRecordList = (value: unknown): value is unknown[] =>
  Array.isArray(value) && value.every(isPlainRecord)

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

function conflict(o: unknown, a: unknown, b: unknown, at: At, walk: Walk): void {
  const kind: FieldConflictKind = isEmptyValue(a)
    ? 'removed-on-base'
    : isEmptyValue(b)
      ? 'removed-by-you'
      : 'changed'
  walk.conflicts.push({
    at: at.segments,
    kind,
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
    return mergeList(o, a, b, at, walk)
  }
  return mergeLeaf(o, a, b, at, walk)
}

/**
 * A side left exactly as the ancestor had it yields to the other side, byte for byte, before any
 * looser equality decides, so `merge(O, A, O)` is A and `merge(O, O, B)` is B.
 */
function mergeLeaf(o: unknown, a: unknown, b: unknown, at: At, walk: Walk): unknown {
  if (equal(o, b)) return a
  if (equal(o, a) || sameValue(a, b) || sameValue(o, a)) return b
  if (sameValue(o, b)) return a
  const empty = o === undefined || isEmptyValue(o)
  if (Array.isArray(a) && Array.isArray(b) && (Array.isArray(o) || empty)) {
    const merged = mergeScalarList(asList(o), a, b)
    if (merged) return merged
  } else if (
    typeof a === 'string' &&
    typeof b === 'string' &&
    (typeof o === 'string' || empty) &&
    `${typeof o === 'string' ? o : ''}${a}${b}`.includes('\n')
  ) {
    const { text, regions } = mergeText(typeof o === 'string' ? o : '', a, b)
    if (regions.length > 0) {
      walk.conflicts.push({ at: at.segments, kind: 'changed', ...versions(o, a, b), regions })
    }
    return text
  }
  conflict(o, a, b, at, walk)
  return b
}

/**
 * diff3 over a list of plain values (tags). Values both sides inserted at the same place are all
 * kept, the base's first, since an insertion loses nothing; any other overlap is undefined, a
 * whole-field conflict.
 */
function mergeScalarList(
  o: readonly unknown[],
  a: readonly unknown[],
  b: readonly unknown[],
): unknown[] | undefined {
  const [oT, aT, bT] = [o, a, b].map((list) => list.map(valueToken))
  const lists = { o, a, b }
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((t, i) => t === y[i])
  const out: unknown[] = []
  for (const region of diff3Regions(aT, oT, bT)) {
    if (region.stable) {
      const list = lists[region.buffer]
      out.push(...list.slice(region.bufferStart, region.bufferStart + region.bufferLength))
      continue
    }
    const slice = (list: readonly unknown[], start: number, length: number) =>
      list.slice(start, start + length)
    const aPart = slice(a, region.aStart, region.aLength)
    const bPart = slice(b, region.bStart, region.bLength)
    if (same(region.aContent, region.bContent)) {
      out.push(...bPart)
    } else if (region.oLength === 0) {
      const inBase = new Set(region.aContent)
      out.push(...aPart, ...bPart.filter((_, n) => !inBase.has(region.bContent[n])))
    } else {
      return undefined
    }
  }
  return out
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
    const v = mergeValue(ancestor[name], a[name], b[name], child(at, { field: name }), walk)
    if (v !== undefined) out[name] = v
  }
  // A list item's key is chosen by its list; any other record's is carried.
  const key = b[ITEM_KEY] ?? a[ITEM_KEY]
  if (!at.item && key !== undefined) out[ITEM_KEY] = key
  return out
}

/**
 * Items are matched across the three versions by identity (`list-alignment.ts`), merged item by
 * item, and ordered by `mergeOrder`. A matched item takes the base's key, else the branch's, so
 * the merged file converges on the base's keys; an item neither side keyed gets no key. An item
 * removed on one side and changed on the other is an item conflict, and the branch's state holds.
 */
function mergeList(
  o: unknown,
  a: readonly unknown[],
  b: readonly unknown[],
  at: At,
  walk: Walk,
  namedBy?: string,
): unknown[] {
  const O = asList(o)
  const { oKeys, aIds, bIds } =
    namedBy === undefined ? identifyByKey(O, a, b) : identifyByName(O, a, b, namedBy)
  const aReadKeys = itemKeysAsRead(a)
  const bReadKeys = itemKeysAsRead(b)
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
    const itemAt: At = {
      segments: [...at.segments, { index: out.length }],
      branchKeys: [...at.branchKeys, (jb !== undefined && bReadKeys[jb]) || id],
      item: true,
    }
    if (i !== undefined && ja === undefined && jb === undefined) continue
    if (i !== undefined && ja === undefined) {
      if (sameValue(oi, bi)) continue
      walk.conflicts.push({
        at: itemAt.segments,
        kind: 'removed-on-base',
        item: true,
        ...versions(oi, ai, bi),
      })
    } else if (i !== undefined && jb === undefined) {
      if (sameValue(oi, ai)) continue
      const named = (ja !== undefined && aReadKeys[ja]) || id
      walk.conflicts.push({
        at: [...at.segments, { item: named }],
        kind: 'removed-by-you',
        item: true,
        ...versions(oi, ai, bi),
      })
      continue
    }
    if (ja === undefined || jb === undefined) {
      out.push(ja === undefined ? bi : ai)
      continue
    }
    const merged = mergeValue(oi, ai, bi, itemAt, walk)
    out.push(
      withListKey(merged, ai, bi, (jb !== undefined && bReadKeys[jb]) || undefined, used, at, walk),
    )
  }
  return out
}

function identifyByKey(O: readonly unknown[], a: readonly unknown[], b: readonly unknown[]) {
  const oKeys = itemKeysAsRead(O).map((key, i) => key ?? `${i}`)
  const aIds = alignToAncestor(a, O, oKeys, 'a')
  const bIds = alignToAncestor(b, O, oKeys, 'b')
  pairNewItems(a, aIds, b, bIds)
  return { oKeys, aIds, bIds }
}

/** Identities by the string member `name`: the first item holding a name is that name's item. */
function identifyByName(
  O: readonly unknown[],
  a: readonly unknown[],
  b: readonly unknown[],
  name: string,
) {
  const ids = (items: readonly unknown[], side: string) => {
    const seen = new Set<string>()
    return items.map((item, j) => {
      const id = isPlainRecord(item) ? item[name] : undefined
      if (typeof id === 'string' && !isNewIdentity(id) && !seen.has(id)) {
        seen.add(id)
        return id
      }
      return newIdentity(side, j)
    })
  }
  return { oKeys: ids(O, 'o'), aIds: ids(a, 'a'), bIds: ids(b, 'b') }
}

/** `merged` with the key its list gives it, recording the remap when the branch's key changes. */
function withListKey(
  merged: unknown,
  ai: unknown,
  bi: unknown,
  branchReadKey: string | undefined,
  used: Set<string>,
  at: At,
  walk: Walk,
): unknown {
  if (!isPlainRecord(merged)) return merged
  const key = [usableKey(ai), usableKey(bi)].find((k) => k !== undefined && !used.has(k))
  if (key === undefined) {
    const carried = isPlainRecord(bi) ? bi[ITEM_KEY] : undefined
    return carried === undefined ? merged : { ...merged, [ITEM_KEY]: carried }
  }
  used.add(key)
  if (branchReadKey !== undefined && branchReadKey !== key) {
    walk.keyRemaps.push({ within: at.branchKeys, from: branchReadKey, to: key })
  }
  return { ...merged, [ITEM_KEY]: key }
}

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
  const { text, regions } = mergeText(o, a, b)
  const parses = (body: string) => format !== 'mdx' || parseMarkdownBody(body, 'mdx') !== undefined
  if (!parses(text) && parses(a) && parses(b)) {
    walk.conflicts.push({
      at: at.segments,
      kind: 'changed',
      ...versions(o, a, b),
      unparseable: true,
    })
    return b
  }
  if (regions.length > 0) {
    walk.conflicts.push({ at: at.segments, kind: 'changed', ...versions(o, a, b), regions })
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
  const walk: Walk = { conflicts: [], keyRemaps: [] }
  const data = mergeRecord(ancestor.data, base.data, branch.data, ROOT, walk)
  const hasBody = [ancestor, base, branch].some((side) => side.body !== undefined)
  const bodyName = findBodyFieldName(fields ?? [])
  const body = hasBody
    ? mergeBody(
        ancestor.body ?? '',
        base.body ?? '',
        branch.body ?? '',
        format,
        child(ROOT, { field: bodyName }),
        walk,
      )
    : undefined
  const read = fields ? entryAsRead(fields, data) : data
  const conflicts = walk.conflicts.map(({ at, ...rest }) => ({
    ...describePath(fields, read, at),
    ...rest,
  }))
  return {
    kind: 'merged',
    data,
    ...(body !== undefined && { body }),
    conflicts,
    keyRemaps: walk.keyRemaps,
  }
}

/**
 * The base's `items` and the branch's merged as ordered sets of distinct values: each side's adds
 * and removes apply, and the order is `mergeOrder`'s. Nothing conflicts: a set entry has no
 * content to change.
 */
export function mergeOrderedSet(
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
  const walk: Walk = { conflicts: [], keyRemaps: [] }
  const data: Record<string, unknown> = {}
  for (const name of new Set([
    ...Object.keys(branch),
    ...Object.keys(base),
    ...Object.keys(ancestor),
  ])) {
    const [o, a, b] = [ancestor[name], base[name], branch[name]]
    const at = child(ROOT, { field: name })
    const lists = [o, a, b].every((v) => v === undefined || Array.isArray(v))
    let v: unknown
    if (name === 'order' && lists && !sameValue(o, b) && !sameValue(o, a)) {
      v = mergeOrderedSet(asList(o), asList(a), asList(b))
    } else if (name === 'entries' && [o, a, b].every((x) => x === undefined || isRecordList(x))) {
      v = mergeList(o, asList(a), asList(b), at, walk, 'name')
    } else {
      v = mergeValue(o, a, b, at, walk)
    }
    if (v !== undefined) data[name] = v
  }
  return {
    data,
    conflicts: walk.conflicts.map(({ at, ...rest }) => ({
      ...describePath(undefined, data, at),
      ...rest,
    })),
  }
}
