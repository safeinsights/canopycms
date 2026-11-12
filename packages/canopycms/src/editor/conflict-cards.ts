/**
 * The cards "Show changes" shows for an entry's open conflicts, built from what
 * `GET /:branch/conflicts/...entryPath` answers (api/merge-conflicts.ts): each place's three
 * versions as the drawer shows values, and long text split into the regions both sides changed.
 * Pure. Where a choice lands in the form value is `conflict-choices.ts`.
 */

import equal from 'fast-deep-equal'

import type { EntryChangeSide } from '../api/branch-entry-changes'
import type { ConflictSide, EntryConflictData, EntryConflictField } from '../api/merge-conflicts'
import type { FieldConfig, ObjectFieldConfig } from '../config'
import type { FieldConflictKind } from '../merge/entry-merge'
import { LOCATION_CONFLICT_KEY } from '../merge/conflict-path'
import { mergeText, type TextConflictRegion } from '../merge/text-merge'
import {
  computeEntryDiff,
  displayWhole,
  textDiff,
  type DataPathSegment,
  type DisplayValue,
  type EntryChange,
  type TextDiff,
} from './entry-diff'
import { flattenGroupFields } from '../utils/flatten-group-fields'
import { humanizeName, schemaLabel } from './schema-label'
import { formValueOfSide, valueAtChange } from './undo-change'
import { ITEM_KEY } from '../item-keys'
import { isPlainRecord } from '../validation/field-traversal'

type FormValue = Record<string, unknown>

/** A version a conflict compares: the entry as read, null where that version has no file. */
type ConflictVersion = EntryChangeSide | null

interface CardBase {
  /** Unique among the entry's cards: the conflict's key, and a region's number within it. */
  id: string
  /** The record's key, which a save's `resolvedConflicts` sends back. */
  key: string
  mergeSha: string
  /** Human labels from the entry down to the place: "Page sections › Hero › Heading". */
  path: string[]
}

/** A value both sides changed: a field, a whole list item, or a value the drawer shows whole. */
interface ValueConflictCard extends CardBase {
  type: 'value'
  conflict: FieldConflictKind
  /** A whole list item or block, which the choice keeps or removes. */
  item: boolean
  before: DisplayValue
  latest: DisplayValue
  yours: DisplayValue
  /** Word or line marks from Before to the latest version, and from Before to yours. */
  latestText?: TextDiff
  yoursText?: TextDiff
  /** The latest version's value here can't be found ({@link FieldConflict.latestPlaceable}). */
  latestUnavailable?: true
}

/** Lines of long text both sides changed, one card per region of a field. */
interface RegionConflictCard extends CardBase {
  type: 'region'
  /** 0-based, among the field's regions. */
  index: number
  count: number
  before: string
  latest: string
  yours: string
  latestText?: TextDiff
  yoursText?: TextDiff
}

/** The entry was moved to different places on each side; the branch's place stands. */
interface LocationConflictCard extends CardBase {
  type: 'location'
}

export type ConflictCard = ValueConflictCard | RegionConflictCard | LocationConflictCard

/** One recorded conflict and what its choices act on. */
export interface FieldConflict {
  key: string
  mergeSha: string
  dataPath: DataPathSegment[]
  item: boolean
  cards: ConflictCard[]
  /** The latest version as a form value, which "Use latest version" takes from. */
  latest?: FormValue
  /**
   * The latest version was read and holds every list item on the place's path, other than the item
   * a removal on its side took out, so its value there can be found and placed. It is keyed as the
   * merge named the place along the base's own path ({@link alignedTo}), so this fails only where
   * the record gives no such path, one that runs another way, or one whose merged key another of
   * its items holds; and where your saved value holds another item at the key of one your version
   * lacks.
   */
  latestPlaceable: boolean
  /**
   * Long text found again by region from its three versions: the text the merge left, and its
   * regions, each holding your lines there. Absent when the text is one whole value.
   */
  text?: { merged: string; regions: TextConflictRegion[] }
}

export interface EntryConflicts {
  fields: FieldConflict[]
  /** Versions the API couldn't show, so a field's cards may show less. */
  incomplete: boolean
}

const EMPTY: DisplayValue = { kind: 'empty' }

/** The version a blob id names; undefined when it can't be shown. */
const versionOf = (
  versions: Readonly<Record<string, ConflictSide>>,
  sha: string | undefined,
): ConflictVersion | undefined => {
  if (sha === undefined) return null
  const side = versions[sha]
  return side === undefined || 'unavailable' in side ? undefined : side
}

/**
 * `version` with its list items along `from`, its own path to a conflict's place, keyed as `to`,
 * the merged path, names them, so `to` finds the value in it: an item of a list a side left keyless
 * reads there with a key of its own content (api/merge-conflicts.ts `EntryConflictField.sidePaths`).
 * Unchanged where there is no `from` or it is `to`. Undefined, as a version that can't be shown,
 * where the two paths don't run alike or a key `to` names is another item's in that list: the
 * merged path would find that item there.
 */
const alignedTo = (
  version: ConflictVersion | undefined,
  from: readonly DataPathSegment[] | undefined,
  to: readonly DataPathSegment[],
): ConflictVersion | undefined => {
  if (!version || !from || equal(from, to)) return version
  // A path one step short of an item names the list of a version without that item.
  const last = to.at(-1)
  const missing =
    from.length === to.length - 1 && last !== undefined && 'item' in last ? last.item : undefined
  if (missing === undefined && from.length !== to.length) return undefined
  const data = structuredClone(version.data)
  let node: unknown = data
  for (const [i, segment] of from.entries()) {
    const target = to[i]
    if ('field' in segment) {
      if (!('field' in target) || target.field !== segment.field) return undefined
      node = isPlainRecord(node) ? node[segment.field] : undefined
    } else if ('blockData' in segment) {
      if (!('blockData' in target)) return undefined
      node = isPlainRecord(node) ? (isPlainRecord(node.value) ? node.value : node) : undefined
    } else {
      if (!('item' in target) || !Array.isArray(node)) return undefined
      const keyed = (key: string) =>
        (node as unknown[]).find((x) => isPlainRecord(x) && x[ITEM_KEY] === key)
      const item = keyed(segment.item)
      if (!isPlainRecord(item)) return undefined
      if (target.item !== segment.item) {
        if (keyed(target.item) !== undefined) return undefined
        item[ITEM_KEY] = target.item
      }
      node = item
    }
  }
  if (missing !== undefined) {
    // Another item there holding the key `to` names would be found as it: it takes another key.
    if (!Array.isArray(node)) return undefined
    const other = node.find((x) => isPlainRecord(x) && x[ITEM_KEY] === missing)
    if (isPlainRecord(other)) other[ITEM_KEY] = `${missing}~other`
  }
  return { ...version, data }
}

/** A diff's changes by key, a whole entry missing on a side giving none. */
const changesByKey = (
  fields: readonly FieldConfig[],
  before: ConflictVersion | undefined,
  after: ConflictVersion | undefined,
  referenceTitle: ((id: string) => string | undefined) | undefined,
): Map<string, EntryChange> => {
  if (!before || !after) return new Map()
  const { changes } = computeEntryDiff({ fields, before, after, referenceTitle })
  return new Map(changes.map((change) => [change.key, change]))
}

/**
 * The schema field a data path ends at, and the labels of the fields on the way, for a conflict no
 * change of the drawer names: one the merge compared whole, such as a list it had no schema for.
 * A block's data has no one field set, so the walk stops there.
 */
const fieldAlong = (
  fields: readonly FieldConfig[],
  dataPath: readonly DataPathSegment[],
): { field?: FieldConfig; path: string[] } => {
  let scope: readonly FieldConfig[] | undefined = fields
  let field: FieldConfig | undefined
  const path: string[] = []
  for (const segment of dataPath) {
    if ('field' in segment) {
      field = scope && flattenGroupFields(scope).find((f) => f.name === segment.field)
      path.push(field ? schemaLabel(field) : humanizeName(segment.field))
      scope = field?.type === 'object' ? (field as ObjectFieldConfig).fields : undefined
    } else if ('item' in segment) {
      field = field && 'list' in field && field.list ? { ...field, list: false } : undefined
    } else {
      return { path }
    }
  }
  return { field, path }
}

/** A string at `dataPath` in a version, as the form holds it. */
const textAt = (
  version: ConflictVersion | undefined,
  dataPath: DataPathSegment[],
  bodyField: string | undefined,
): string | undefined => {
  if (!version) return version === null ? '' : undefined
  const value = valueAtChange(formValueOfSide(version), { dataPath }, bodyField)
  return typeof value === 'string' ? value : value === undefined ? '' : undefined
}

/**
 * The cards for one entry's open field conflicts. `bodyField` is the schema's body field on an
 * md/mdx entry. Each version the cards compare is diffed once per pair, however many fields share it.
 */
export function buildEntryConflicts(
  data: EntryConflictData,
  fields: readonly FieldConfig[],
  bodyField: string | undefined,
  referenceTitle?: (id: string) => string | undefined,
  saved?: FormValue,
): EntryConflicts {
  const diffs = new Map<string, Map<string, EntryChange>>()
  const diff = (from: string | undefined, to: string | undefined): Map<string, EntryChange> => {
    const id = `${from ?? '-'}>${to ?? '-'}`
    let found = diffs.get(id)
    if (!found) {
      found = changesByKey(
        fields,
        versionOf(data.versions, from),
        versionOf(data.versions, to),
        referenceTitle,
      )
      diffs.set(id, found)
    }
    return found
  }
  let incomplete = false
  const out = data.fields.map((field: EntryConflictField): FieldConflict => {
    const { ancestor, base, branch } = field.sides
    const read = {
      before: versionOf(data.versions, ancestor),
      latest: versionOf(data.versions, base),
      yours: versionOf(data.versions, branch),
    }
    if (Object.values(read).some((v) => v === undefined)) incomplete = true
    // Each version keyed as the merge named this place, so the one data path finds it in all three.
    const versions = {
      before: alignedTo(read.before, field.sidePaths.ancestor, field.dataPath),
      latest: alignedTo(read.latest, field.sidePaths.base, field.dataPath),
      yours: alignedTo(read.yours, field.sidePaths.branch, field.dataPath),
    }
    const realigned = (['before', 'latest', 'yours'] as const).some((v) => versions[v] !== read[v])
    if (Object.values(versions).some((v) => v === undefined)) incomplete = true
    const latest = versions.latest ? formValueOfSide(versions.latest) : undefined
    // Your saved value where a save since the merge changed it, which is what keeping yours keeps:
    // the branch's version is only how it read at the merge.
    const savedHere = saved && valueAtChange(saved, { dataPath: field.dataPath }, bodyField)
    const branchHere =
      versions.yours &&
      valueAtChange(formValueOfSide(versions.yours), { dataPath: field.dataPath }, bodyField)
    // A read of the merged file can key another item, one alike or a copy, as the merge named an
    // item your version lacks: a choice would land on that other item.
    const otherItemHere =
      field.item && !!versions.yours && branchHere === undefined && savedHere !== undefined
    const latestFound =
      !!latest &&
      field.dataPath.every(
        (segment, i) =>
          !('item' in segment) ||
          (field.item && field.kind === 'removed-on-base' && i === field.dataPath.length - 1) ||
          valueAtChange(latest, { dataPath: field.dataPath.slice(0, i + 1) }, bodyField) !==
            undefined,
      )
    const latestPlaceable = latestFound && !otherItemHere
    const common = {
      key: field.key,
      mergeSha: field.mergeSha,
      dataPath: field.dataPath,
      item: !!field.item,
      latestPlaceable,
      ...(latest && { latest }),
    }
    const card = { key: field.key, mergeSha: field.mergeSha }
    if (field.key === LOCATION_CONFLICT_KEY) {
      return { ...common, cards: [{ ...card, id: field.key, type: 'location', path: [] }] }
    }
    // A realigned version is this field's own, so its diffs are too.
    const pair = (
      from: ConflictVersion | undefined,
      to: ConflictVersion | undefined,
      fromSha: string | undefined,
      toSha: string | undefined,
    ) => (realigned ? changesByKey(fields, from, to, referenceTitle) : diff(fromSha, toSha))
    const toLatest = pair(versions.before, versions.latest, ancestor, base)
    const toYours = pair(versions.before, versions.yours, ancestor, branch)
    const between = pair(versions.latest, versions.yours, base, branch)
    const named = toLatest.get(field.drawerKey) ?? toYours.get(field.drawerKey)
    const along = fieldAlong(fields, field.dataPath)
    const path = named?.path ?? between.get(field.drawerKey)?.path ?? along.path
    const savedYours =
      saved && !otherItemHere && !equal(savedHere, branchHere)
        ? displayWhole(along.field, savedHere, referenceTitle)
        : undefined
    const savedMarks = (before: DisplayValue): TextDiff | undefined =>
      savedYours && before.kind === 'text' && savedYours.kind === 'text'
        ? textDiff(before.text, savedYours.text)
        : undefined

    if (field.text) {
      const texts = [versions.before, versions.latest, versions.yours].map((v) =>
        textAt(v, field.dataPath, bodyField),
      )
      const [o, a, b] = texts
      const merged =
        latestPlaceable && o !== undefined && a !== undefined && b !== undefined
          ? mergeText(o, a, b)
          : undefined
      // Regions place their lines in the text the merge left, so they apply only while your saved
      // text is that text: not once you saved since, nor where the merge kept your text whole.
      const regionsApply =
        !!merged &&
        merged.regions.length > 0 &&
        (saved === undefined ||
          valueAtChange(saved, { dataPath: field.dataPath }, bodyField) === merged.text)
      if (merged && regionsApply) {
        return {
          ...common,
          text: { merged: merged.text, regions: merged.regions },
          cards: merged.regions.map(
            (region, index): RegionConflictCard => ({
              ...card,
              id: `${field.key}#${index}`,
              type: 'region',
              path,
              index,
              count: merged.regions.length,
              before: region.ancestor,
              latest: region.base,
              yours: region.branch,
              latestText: textDiff(region.ancestor, region.base, true),
              yoursText: textDiff(region.ancestor, region.branch, true),
            }),
          ),
        }
      }
    }

    const fromLatest = toLatest.get(field.drawerKey)
    const fromYours = toYours.get(field.drawerKey)
    const across = between.get(field.drawerKey)
    if (!fromLatest && !fromYours && !across) {
      // No change of the drawer is at this place: the merge compared it whole, so it shows whole.
      const whole = (version: ConflictVersion | undefined): DisplayValue =>
        version
          ? displayWhole(
              along.field,
              valueAtChange(formValueOfSide(version), { dataPath: field.dataPath }, bodyField),
              referenceTitle,
            )
          : EMPTY
      const [before, latestValue, yoursValue] = [
        versions.before,
        versions.latest,
        versions.yours,
      ].map(whole)
      const marks = (to: DisplayValue) =>
        before.kind === 'text' && to.kind === 'text' ? textDiff(before.text, to.text) : undefined
      const latestText = marks(latestValue)
      const yoursText = savedYours ? savedMarks(before) : marks(yoursValue)
      return {
        ...common,
        cards: [
          {
            ...card,
            id: field.key,
            type: 'value',
            conflict: field.kind,
            item: !!field.item,
            path,
            before,
            latest: latestValue,
            ...(!latestFound && { latestUnavailable: true as const }),
            yours: savedYours ?? yoursValue,
            ...(latestText && { latestText }),
            ...(yoursText && { yoursText }),
          },
        ],
      }
    }
    const before = fromLatest?.before ?? fromYours?.before ?? EMPTY
    const yoursText = savedYours ? savedMarks(before) : fromYours?.text
    return {
      ...common,
      cards: [
        {
          ...card,
          id: field.key,
          type: 'value',
          conflict: field.kind,
          item: !!field.item,
          path,
          before,
          latest: fromLatest ? (fromLatest.after ?? EMPTY) : (across?.before ?? EMPTY),
          ...(!latestFound && { latestUnavailable: true as const }),
          yours: savedYours ?? (fromYours ? (fromYours.after ?? EMPTY) : (across?.after ?? EMPTY)),
          ...(fromLatest?.text && { latestText: fromLatest.text }),
          ...(yoursText && { yoursText }),
        },
      ],
    }
  })
  return { fields: out, incomplete }
}
