/**
 * The cards "Show changes" shows for an entry's open conflicts, built from what
 * `GET /:branch/conflicts/...entryPath` answers (api/merge-conflicts.ts): each place's three
 * versions as the drawer shows values, and long text split into the regions both sides changed.
 * Pure. Where a choice lands in the form value is `conflict-choices.ts`.
 */

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
   * a removal on its side took out, so its value there can be found and placed. A list the base
   * left keyless reads with keys of its own content, which needn't be the ones the merge named.
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
    const versions = {
      before: versionOf(data.versions, ancestor),
      latest: versionOf(data.versions, base),
      yours: versionOf(data.versions, branch),
    }
    if (Object.values(versions).some((v) => v === undefined)) incomplete = true
    const latest = versions.latest ? formValueOfSide(versions.latest) : undefined
    const latestPlaceable =
      !!latest &&
      field.dataPath.every(
        (segment, i) =>
          !('item' in segment) ||
          (field.item && field.kind === 'removed-on-base' && i === field.dataPath.length - 1) ||
          valueAtChange(latest, { dataPath: field.dataPath.slice(0, i + 1) }, bodyField) !==
            undefined,
      )
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
    const toLatest = diff(ancestor, base)
    const toYours = diff(ancestor, branch)
    const between = diff(base, branch)
    const named = toLatest.get(field.drawerKey) ?? toYours.get(field.drawerKey)
    const along = fieldAlong(fields, field.dataPath)
    const path = named?.path ?? between.get(field.drawerKey)?.path ?? along.path

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
      const yoursText = marks(yoursValue)
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
            ...(!latestPlaceable && { latestUnavailable: true as const }),
            yours: yoursValue,
            ...(latestText && { latestText }),
            ...(yoursText && { yoursText }),
          },
        ],
      }
    }
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
          before: fromLatest?.before ?? fromYours?.before ?? EMPTY,
          latest: fromLatest ? (fromLatest.after ?? EMPTY) : (across?.before ?? EMPTY),
          ...(!latestPlaceable && { latestUnavailable: true as const }),
          yours: fromYours ? (fromYours.after ?? EMPTY) : (across?.after ?? EMPTY),
          ...(fromLatest?.text && { latestText: fromLatest.text }),
          ...(fromYours?.text && { yoursText: fromYours.text }),
        },
      ],
    }
  })
  return { fields: out, incomplete }
}
