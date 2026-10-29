/**
 * What changed in one entry between two saved states, field by field, for the "Show changes"
 * drawer. Pure and client-safe: it walks the entry type's schema, so each change carries the
 * labels the form shows, and lists and blocks match their items by item key (`item-keys.ts`),
 * so a reordered item reads as moved, not as one removed and one added.
 */

import { diffLines, diffWordsWithSpace, type Change } from 'diff'
import equal from 'fast-deep-equal'

import type { BlockFieldConfig, FieldConfig, ObjectFieldConfig, SelectFieldConfig } from '../config'
import type { EntryChangeSide } from '../api/branch-entry-changes'
import { ITEM_KEY } from '../item-keys'
import { findBodyFieldName } from '../utils/body-field'
import { flattenGroupFields } from '../utils/flatten-group-fields'
import { isPlainRecord, resolveBlockItem } from '../validation/field-traversal'
import { listItemHeading, listItemTitle } from './fields/list-item-title'
import { humanizeName, schemaLabel } from './schema-label'

/** A run of text on one side of a text change; `added` and `removed` runs are the difference. */
export interface DiffPart {
  value: string
  added?: true
  removed?: true
}

/**
 * One row of a line diff, its Before and After lines side by side: an unchanged line on both, a
 * changed pair, or a line on one side only (the other side's cell is empty). `skipped` stands
 * for unchanged lines left out between changes.
 */
export type DiffRow =
  | { kind: 'same'; text: string }
  | { kind: 'change'; before?: DiffPart[]; after?: DiffPart[] }
  | { kind: 'skipped'; count: number }

/**
 * A text change: word by word for a short value, row by row with word marks for long text, or a
 * line break added or removed at the very end, the only difference.
 */
export type TextDiff =
  | { mode: 'words'; parts: DiffPart[] }
  | { mode: 'lines'; rows: DiffRow[] }
  | { mode: 'endLineBreak'; added: boolean }

/** A value as the drawer shows it. */
export type DisplayValue =
  | { kind: 'empty' }
  | { kind: 'text'; text: string; long?: true }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  /** `text`, its absolute local form; `dateOnly`: a calendar date, read as local midnight. */
  | { kind: 'date'; iso: string; text: string; dateOnly?: true }
  | { kind: 'select'; label: string }
  /** No `title` when the editor's entry list has no entry with this id. */
  | { kind: 'reference'; id: string; title?: string }
  | { kind: 'image'; src: string; name: string; alt?: string }
  /** A list item's place, 1-based, among `of` items, for a move. */
  | { kind: 'position'; position: number; of: number }
  | { kind: 'list'; items: DisplayValue[] }
  /** A whole object, list item or block, as its labelled fields. */
  | { kind: 'fields'; fields: Array<{ label: string; value: DisplayValue }> }
  /** A value of a shape the schema doesn't describe, as JSON. */
  | { kind: 'raw'; text: string }

export interface EntryChange {
  /** Stable among one diff's changes: its data path, list items named by key. */
  key: string
  /** Human labels from the entry down to the change: "Page sections › Hero › Heading". */
  path: string[]
  kind: 'added' | 'removed' | 'changed' | 'moved'
  before?: DisplayValue
  after?: DisplayValue
  text?: TextDiff
  /** Both sides' images' alt texts, diffed by word. */
  altText?: TextDiff
  /** The text differs too much to mark within the time allowed: show both sides whole. */
  tooLargeToMark?: true
}

export interface EntryDiff {
  changes: EntryChange[]
  /** Both sides exist and hold equal values: only the file's formatting differs. */
  formattingOnly: boolean
}

export interface EntryDiffInput {
  /** The entry type's fields. */
  fields: readonly FieldConfig[]
  before: EntryChangeSide | null
  after: EntryChangeSide | null
  /** A referenced entry's title, from the entries the editor has listed. */
  referenceTitle?: (id: string) => string | undefined
}

/** Where the walk is: the labels so far and the data path that keys the change. */
interface At {
  path: string[]
  key: string
}

/** Text at most this long, on one line, gets a word diff; longer text a line diff. */
const SHORT_TEXT = 200
/** Unchanged lines kept on each side of a change in a line diff. */
const CONTEXT_LINES = 2
/**
 * How long one entry's text diffing may take in all, on the editor's main thread, where jsdiff's
 * run time grows with the square of the edits. The deadline is checked before each jsdiff call,
 * and each call is given only the time left; past it, every text change left is shown unmarked.
 */
const DIFF_TIMEOUT_MS = 300
const OTHER_FIELDS_LABEL = 'Other fields'
const LONG_TEXT_TYPES = new Set(['markdown', 'mdx', 'code'])

/** A side's data with an md/mdx body under that side's body field, as the form holds it. */
const formValue = (
  fields: readonly FieldConfig[],
  side: EntryChangeSide | null,
): Record<string, unknown> | undefined => {
  if (!side) return undefined
  if (side.body === undefined) return side.data
  return { ...side.data, [side.bodyFieldName ?? findBodyFieldName(fields)]: side.body }
}

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0) ||
  (isPlainRecord(value) && Object.keys(value).every((k) => k === ITEM_KEY || isEmpty(value[k])))

/** `value` without item keys and empty members, so equal content compares equal. */
const normalized = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalized)
  if (!isPlainRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (k !== ITEM_KEY && !isEmpty(v)) out[k] = normalized(v)
  }
  return out
}

const sameValue = (a: unknown, b: unknown): boolean =>
  (isEmpty(a) && isEmpty(b)) || equal(normalized(a), normalized(b))

const at = (parent: At, label: string, key: string): At => ({
  path: [...parent.path, label],
  key: parent.key ? `${parent.key}.${key}` : key,
})

/** A member the schema doesn't name, under an "Other fields" crumb. */
const otherAt = (parent: At, name: string): At => ({
  path: [...parent.path, OTHER_FIELDS_LABEL, humanizeName(name)],
  key: `${parent.key}?${name}`,
})

/** The file name of an image `src`, its query and fragment dropped. */
const fileName = (src: string): string => {
  const last = src.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? src
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

const rawText = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(normalized(value), null, 2) ?? String(value))

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/**
 * A date as a comparison shows it: absolute, in the viewer's locale, with the time zone. The
 * editor's dates are otherwise relative, but two relative dates can read alike while their values
 * differ, which is the one thing a comparison must show.
 */
const formatDate = (iso: string, dateOnly: boolean, seconds = false): string => {
  if (dateOnly) {
    const [year, month, day] = iso.split('-').map(Number)
    return new Date(year, month - 1, day).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(seconds && { second: '2-digit' as const }),
    timeZoneName: 'short',
  })
}

/** Two date-time values naming one instant, however spelled: no change. */
const sameInstant = (field: FieldConfig | undefined, a: unknown, b: unknown): boolean => {
  if (field?.type !== 'datetime' || typeof a !== 'string' || typeof b !== 'string') return false
  const [x, y] = [Date.parse(a), Date.parse(b)]
  return !Number.isNaN(x) && x === y
}

/** Two date-times in the same minute are shown to the second, so their difference shows. */
const withSecondsWhenNeeded = (
  before: Extract<DisplayValue, { kind: 'date' }>,
  after: Extract<DisplayValue, { kind: 'date' }>,
): void => {
  if (before.dateOnly || after.dateOnly) return
  if (Math.floor(Date.parse(before.iso) / 60_000) !== Math.floor(Date.parse(after.iso) / 60_000)) {
    return
  }
  before.text = formatDate(before.iso, false, true)
  after.text = formatDate(after.iso, false, true)
}

/** The text a display marks word by word in a change: text values', and dates' absolute form. */
const markableText = (value: DisplayValue | undefined): string | undefined =>
  value?.kind === 'text' || value?.kind === 'date' ? value.text : undefined

class Walker {
  readonly changes: EntryChange[] = []

  constructor(
    private readonly referenceTitle: ((id: string) => string | undefined) | undefined,
    /** The `Date.now()` past which no more text is diffed. */
    private readonly deadline: number,
  ) {}

  /** `value` of `field`, as the drawer shows it. */
  display(field: FieldConfig | undefined, value: unknown): DisplayValue {
    if (isEmpty(value)) return { kind: 'empty' }
    if (field && 'list' in field && field.list && field.type !== 'object') {
      const items = Array.isArray(value) ? value : [value]
      return {
        kind: 'list',
        items: items.map((item) => this.display({ ...field, list: false }, item)),
      }
    }
    switch (field?.type) {
      case 'object': {
        const objectField = field as ObjectFieldConfig
        if (objectField.list && Array.isArray(value)) {
          return {
            kind: 'list',
            items: value.map((item) => this.record(objectField.fields, item)),
          }
        }
        return this.record(objectField.fields, value)
      }
      case 'block': {
        const blockField = field as BlockFieldConfig
        const items = Array.isArray(value) ? value : []
        return { kind: 'list', items: items.map((item) => this.blockRecord(blockField, item)) }
      }
      case 'reference':
        if (typeof value === 'string') {
          const title = this.referenceTitle?.(value)
          return { kind: 'reference', id: value, ...(title !== undefined && { title }) }
        }
        break
      case 'image':
        if (isPlainRecord(value) && typeof value.src === 'string') {
          return {
            kind: 'image',
            src: value.src,
            name: fileName(value.src),
            ...(typeof value.alt === 'string' && value.alt !== '' && { alt: value.alt }),
          }
        }
        break
      case 'select': {
        const option = (field as SelectFieldConfig).options?.find(
          (o) => (typeof o === 'string' ? o : o.value) === value,
        )
        if (option !== undefined) {
          return { kind: 'select', label: typeof option === 'string' ? option : option.label }
        }
        break
      }
      case 'datetime':
        if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
          return DATE_ONLY.test(value)
            ? { kind: 'date', iso: value, text: formatDate(value, true), dateOnly: true }
            : { kind: 'date', iso: value, text: formatDate(value, false) }
        }
        break
      default:
        break
    }
    if (typeof value === 'string') {
      return field && LONG_TEXT_TYPES.has(field.type)
        ? { kind: 'text', text: value, long: true }
        : { kind: 'text', text: value }
    }
    if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'number', value }
    if (typeof value === 'boolean') return { kind: 'boolean', value }
    return { kind: 'raw', text: rawText(value) }
  }

  /** A record's non-empty fields, schema fields first, then the ones it doesn't describe. */
  record(fields: readonly FieldConfig[], value: unknown): DisplayValue {
    if (!isPlainRecord(value)) return this.display(undefined, value)
    const flat = flattenGroupFields(fields)
    const known = new Set(flat.map((f) => f.name))
    const out: Array<{ label: string; value: DisplayValue }> = []
    for (const field of flat) {
      if (!isEmpty(value[field.name])) {
        out.push({ label: schemaLabel(field), value: this.display(field, value[field.name]) })
      }
    }
    for (const [name, v] of Object.entries(value)) {
      if (!known.has(name) && name !== ITEM_KEY && !isEmpty(v)) {
        out.push({ label: humanizeName(name), value: this.display(undefined, v) })
      }
    }
    return out.length === 0 ? { kind: 'empty' } : { kind: 'fields', fields: out }
  }

  blockRecord(field: BlockFieldConfig, item: unknown): DisplayValue {
    const resolved = isPlainRecord(item) ? resolveBlockItem(field, item) : undefined
    return resolved ? this.record(resolved.fields, resolved.data) : this.display(undefined, item)
  }

  /** Compares two records by `fields`, then the members the schema doesn't name. */
  fields(
    fields: readonly FieldConfig[],
    before: Record<string, unknown> | undefined,
    after: Record<string, unknown> | undefined,
    where: At,
  ): void {
    const flat = flattenGroupFields(fields)
    const known = new Set(flat.map((f) => f.name))
    for (const field of flat) {
      this.field(
        field,
        before?.[field.name],
        after?.[field.name],
        at(where, schemaLabel(field), field.name),
      )
    }
    const others = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
    for (const name of others) {
      if (known.has(name) || name === ITEM_KEY) continue
      this.value(undefined, before?.[name], after?.[name], otherAt(where, name))
    }
  }

  field(field: FieldConfig, before: unknown, after: unknown, where: At): void {
    if (sameValue(before, after)) return
    if (field.type === 'block') {
      this.list(before, after, where, {
        heading: (item) => this.blockHeading(field as BlockFieldConfig, item),
        compare: (b, a, itemAt) => this.block(field as BlockFieldConfig, b, a, itemAt),
        display: (item) => this.blockRecord(field as BlockFieldConfig, item),
      })
      return
    }
    if (field.type === 'object') {
      const objectField = field as ObjectFieldConfig
      if (objectField.list) {
        this.list(before, after, where, {
          heading: (item, index) => listItemHeading(item, objectField, index),
          compare: (b, a, itemAt) =>
            this.fields(objectField.fields, asRecord(b), asRecord(a), itemAt),
          display: (item) => this.record(objectField.fields, item),
        })
        return
      }
      if ((isPlainRecord(before) || isEmpty(before)) && (isPlainRecord(after) || isEmpty(after))) {
        this.fields(objectField.fields ?? [], asRecord(before), asRecord(after), where)
        return
      }
    }
    this.value(field, before, after, where)
  }

  /** One leaf change: a value set, cleared or changed. */
  value(field: FieldConfig | undefined, before: unknown, after: unknown, where: At): void {
    if (sameValue(before, after) || sameInstant(field, before, after)) return
    const kind = isEmpty(before) ? 'added' : isEmpty(after) ? 'removed' : 'changed'
    const change: EntryChange = { key: where.key, path: where.path, kind }
    if (kind !== 'added') change.before = this.display(field, before)
    if (kind !== 'removed') change.after = this.display(field, after)
    // Text and dates only: a reference's id is a value, shown whole.
    const beforeText = markableText(change.before)
    const afterText = markableText(change.after)
    if (
      beforeText !== undefined &&
      afterText !== undefined &&
      change.before?.kind === change.after?.kind
    ) {
      const long = change.after?.kind === 'text' && !!change.after.long
      if (change.before?.kind === 'date' && change.after?.kind === 'date') {
        withSecondsWhenNeeded(change.before, change.after)
      }
      const text = textDiff(
        markableText(change.before) ?? beforeText,
        markableText(change.after) ?? afterText,
        long,
        this.deadline,
      )
      if (text) change.text = text
      else change.tooLargeToMark = true
    }
    if (
      change.before?.kind === 'image' &&
      change.after?.kind === 'image' &&
      change.before.alt !== undefined &&
      change.after.alt !== undefined &&
      change.before.alt !== change.after.alt
    ) {
      const alt = textDiff(change.before.alt, change.after.alt, false, this.deadline)
      if (alt) change.altText = alt
    }
    this.changes.push(change)
  }

  blockHeading(field: BlockFieldConfig, item: unknown): string {
    const record = isPlainRecord(item) ? item : {}
    const templateName = typeof record.template === 'string' ? record.template : undefined
    const template = field.templates.find((t) => t.name === templateName)
    const label = template
      ? schemaLabel(template)
      : templateName
        ? humanizeName(templateName)
        : 'Block'
    const resolved = resolveBlockItem(field, record)
    const title = resolved ? listItemTitle(resolved.data, { fields: resolved.fields }) : undefined
    return title ? `${label}: ${title}` : label
  }

  block(field: BlockFieldConfig, before: unknown, after: unknown, where: At): void {
    const b = isPlainRecord(before) ? resolveBlockItem(field, before) : undefined
    const a = isPlainRecord(after) ? resolveBlockItem(field, after) : undefined
    const sameTemplate =
      isPlainRecord(before) && isPlainRecord(after) && before.template === after.template
    if (b && a && sameTemplate) {
      this.fields(a.fields, b.data, a.data, where)
      return
    }
    if (sameValue(before, after)) return
    this.changes.push({
      key: where.key,
      path: where.path,
      kind: 'changed',
      before: this.blockRecord(field, before),
      after: this.blockRecord(field, after),
    })
  }

  /**
   * Compares two lists item by item, matched by item key: an item on one side only is added or
   * removed, and one whose place among the matched items changed is moved. Items keep their
   * order relative to each other when they are on the longest common run of the two orders,
   * so moving one item marks that item alone.
   */
  list(
    before: unknown,
    after: unknown,
    where: At,
    item: {
      heading: (item: unknown, index: number) => string
      compare: (before: unknown, after: unknown, where: At) => void
      display: (item: unknown) => DisplayValue
    },
  ): void {
    const bItems = Array.isArray(before) ? before : []
    const aItems = Array.isArray(after) ? after : []
    const keyOf = (value: unknown, index: number, side: string): string =>
      isPlainRecord(value) && typeof value[ITEM_KEY] === 'string'
        ? value[ITEM_KEY]
        : `${side}#${index}`
    const bKeys = bItems.map((v, i) => keyOf(v, i, 'before'))
    const aKeys = aItems.map((v, i) => keyOf(v, i, 'after'))
    const bIndex = new Map(bKeys.map((k, i) => [k, i]))
    const aSet = new Set(aKeys)
    const shared = aKeys.filter((k) => bIndex.has(k))
    const stayed = longestCommonRun(
      bKeys.filter((k) => aSet.has(k)),
      shared,
    )

    aItems.forEach((value, index) => {
      const key = aKeys[index]
      const from = bIndex.get(key)
      // A matched item is named as it was at the base, so a change to its title doesn't rename
      // the path to it.
      const itemAt = at(
        where,
        from === undefined ? item.heading(value, index) : item.heading(bItems[from], from),
        key,
      )
      if (from === undefined) {
        this.changes.push({
          key: itemAt.key,
          path: itemAt.path,
          kind: 'added',
          after: item.display(value),
        })
        return
      }
      if (!stayed.has(key)) {
        this.changes.push({
          key: `${itemAt.key}#moved`,
          path: itemAt.path,
          kind: 'moved',
          before: { kind: 'position', position: from + 1, of: bItems.length },
          after: { kind: 'position', position: index + 1, of: aItems.length },
        })
      }
      item.compare(bItems[from], value, itemAt)
    })
    bItems.forEach((value, index) => {
      const key = bKeys[index]
      if (aSet.has(key)) return
      const itemAt = at(where, item.heading(value, index), key)
      this.changes.push({
        key: itemAt.key,
        path: itemAt.path,
        kind: 'removed',
        before: item.display(value),
      })
    })
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  isPlainRecord(value) ? value : undefined

/**
 * The keys on a longest common subsequence of `a` and `b`, two orders of the same distinct keys.
 * With distinct keys that is a longest increasing run of `b`'s positions read in `a`'s order,
 * found in O(n log n) by patience sorting, so a list of thousands of items stays quick.
 */
const longestCommonRun = (a: readonly string[], b: readonly string[]): Set<string> => {
  const position = new Map(b.map((key, i) => [key, i]))
  const seq = a.map((key) => position.get(key) ?? -1)
  // tails[n]: the index in `seq` of the smallest last value of an increasing run of length n+1.
  const tails: number[] = []
  const previous = new Array<number>(seq.length).fill(-1)
  for (let i = 0; i < seq.length; i++) {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (seq[tails[mid]] < seq[i]) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) previous[i] = tails[lo - 1]
    tails[lo] = i
  }
  const out = new Set<string>()
  for (let i = tails.length > 0 ? tails[tails.length - 1] : -1; i >= 0; i = previous[i]) {
    out.add(a[i])
  }
  return out
}

const WHITESPACE = /^\s+$/

/**
 * jsdiff's changes as parts. A gap of whitespace widened or narrowed comes back as the old gap
 * removed and the new one added; it is kept as their common start, then only the net change.
 */
const toParts = (changes: Change[]): DiffPart[] => {
  const parts: DiffPart[] = []
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i]
    const next = changes[i + 1]
    if (
      next &&
      c.removed !== next.removed &&
      (c.removed || c.added) &&
      (next.removed || next.added) &&
      WHITESPACE.test(c.value) &&
      WHITESPACE.test(next.value)
    ) {
      const [removed, added] = c.removed ? [c.value, next.value] : [next.value, c.value]
      const shorter = removed.length < added.length ? removed : added
      const longer = shorter === removed ? added : removed
      if (longer.startsWith(shorter)) {
        parts.push({ value: shorter })
        const rest = longer.slice(shorter.length)
        parts.push(
          shorter === removed ? { value: rest, added: true } : { value: rest, removed: true },
        )
        i++
        continue
      }
    }
    parts.push({
      value: c.value,
      ...(c.added && { added: true as const }),
      ...(c.removed && { removed: true as const }),
    })
  }
  return parts
}

/** A side of a changed row that kept no text: a blank line, marked, so the row says so. */
const sideParts = (parts: DiffPart[], mark: 'removed' | 'added'): DiffPart[] =>
  parts.some((p) => p.value !== '')
    ? parts
    : [mark === 'removed' ? { value: '', removed: true } : { value: '', added: true }]

const splitLines = (value: string): string[] => {
  const lines = value.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * The difference between two texts. Short single-line text is diffed by word; anything else by
 * line, a removed line paired with the added line in its place diffed by word inside, and runs
 * of unchanged lines cut to {@link CONTEXT_LINES} beside each change. Words are diffed with
 * whitespace as tokens (`diffWordsWithSpace`): `diffWords` gives an unchanged run the new
 * text's spacing, so one side read back from its parts would not be the text it was.
 * Undefined once `deadline` (a `Date.now()`) passes: no jsdiff call starts after it.
 * @internal Exported for tests.
 */
export function textDiff(
  before: string,
  after: string,
  long = false,
  deadline = Date.now() + DIFF_TIMEOUT_MS,
): TextDiff | undefined {
  // jsdiff restarts its clock on each call, so each is given only what is left of the budget.
  const timeLeft = (): { timeout: number } | undefined => {
    const left = deadline - Date.now()
    return left > 0 ? { timeout: left } : undefined
  }
  const withoutEnd = (text: string) => (text.endsWith('\n') ? text.slice(0, -1) : text)
  if (before !== after && withoutEnd(before) === withoutEnd(after)) {
    return { mode: 'endLineBreak', added: after.endsWith('\n') }
  }
  const short =
    !long &&
    !before.includes('\n') &&
    !after.includes('\n') &&
    before.length <= SHORT_TEXT &&
    after.length <= SHORT_TEXT
  if (short) {
    const budget = timeLeft()
    const words = budget && diffWordsWithSpace(before, after, budget)
    return words ? { mode: 'words', parts: toParts(words) } : undefined
  }

  const rows: DiffRow[] = []
  const budget = timeLeft()
  const changes = budget && diffLines(before, after, budget)
  if (!changes) return undefined
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]
    if (!change.added && !change.removed) {
      for (const text of splitLines(change.value)) rows.push({ kind: 'same', text })
      continue
    }
    const removed = change.removed ? splitLines(change.value) : []
    const next = changes[i + 1]
    const added =
      change.removed && next?.added
        ? splitLines(next.value)
        : change.added
          ? splitLines(change.value)
          : []
    if (change.removed && next?.added) i++
    const paired = Math.min(removed.length, added.length)
    for (let n = 0; n < paired; n++) {
      const pairBudget = timeLeft()
      const changed = pairBudget && diffWordsWithSpace(removed[n], added[n], pairBudget)
      if (!changed) return undefined
      const words = toParts(changed)
      rows.push({
        kind: 'change',
        before: sideParts(
          words.filter((p) => !p.added),
          'removed',
        ),
        after: sideParts(
          words.filter((p) => !p.removed),
          'added',
        ),
      })
    }
    for (const text of removed.slice(paired))
      rows.push({ kind: 'change', before: [{ value: text, removed: true }] })
    for (const text of added.slice(paired))
      rows.push({ kind: 'change', after: [{ value: text, added: true }] })
  }
  return { mode: 'lines', rows: withContext(rows) }
}

/** `lines` with each run of unchanged lines cut to the context beside its changes. */
const withContext = (lines: DiffRow[]): DiffRow[] => {
  const out: DiffRow[] = []
  for (let i = 0; i < lines.length; ) {
    if (lines[i].kind !== 'same') {
      out.push(lines[i++])
      continue
    }
    let end = i
    while (end < lines.length && lines[end].kind === 'same') end++
    const keepBefore = i === 0 ? 0 : CONTEXT_LINES
    const keepAfter = end === lines.length ? 0 : CONTEXT_LINES
    if (end - i <= keepBefore + keepAfter + 1) {
      out.push(...lines.slice(i, end))
    } else {
      out.push(...lines.slice(i, i + keepBefore))
      out.push({ kind: 'skipped', count: end - i - keepBefore - keepAfter })
      out.push(...lines.slice(end - keepAfter, end))
    }
    i = end
  }
  return out
}

/** The entry's changes between `before` and `after`, in schema order. */
export function computeEntryDiff({
  fields,
  before,
  after,
  referenceTitle,
}: EntryDiffInput): EntryDiff {
  // One budget for the whole entry: see DIFF_TIMEOUT_MS.
  const walker = new Walker(referenceTitle, Date.now() + DIFF_TIMEOUT_MS)
  const root: At = { path: [], key: '' }
  if (before && after && before.entryType !== after.entryType) {
    walker.value(
      undefined,
      humanizeName(before.entryType),
      humanizeName(after.entryType),
      at(root, 'Entry type', '$entryType'),
    )
  }
  walker.fields(fields, formValue(fields, before), formValue(fields, after), root)
  const changes = walker.changes
  return { changes, formattingOnly: !!before && !!after && changes.length === 0 }
}
