/**
 * "Use latest version" over generated merges of duplicate-heavy lists, some items keyed by an
 * earlier save and some not: a choice changes the item the merge named, the one holding your value
 * at the conflict's place, or none at all, and never another item that holds its key in the form.
 */

import equal from 'fast-deep-equal'
import { describe, expect, it } from 'vitest'

import type { EntryConflictData } from '../api/merge-conflicts'
import type { FieldConfig } from '../config'
import { ITEM_KEY } from '../item-keys'
import { mergeEntry } from '../merge/entry-merge'
import { entryAsRead } from '../utils/calendar-day'
import { buildEntryConflicts, type FieldConflict } from './conflict-cards'
import { withLatest } from './conflict-choices'

/** mulberry32: a small seeded generator, so a failure names its seed. */
const generator = (seed: number) => {
  let t = seed >>> 0
  const next = () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]
  return { next, int, pick }
}
type Gen = ReturnType<typeof generator>
type Item = Record<string, unknown>
type Value = { items: Item[] }

const schema: FieldConfig[] = [
  {
    name: 'items',
    type: 'object',
    list: true,
    fields: [
      { name: 'title', type: 'string' },
      { name: 'note', type: 'string' },
    ],
  },
]

const TITLES = ['A', 'B', 'C']
const NOTES = ['n', 'm']
const fresh = (g: Gen): Item => ({ title: g.pick(TITLES), note: g.pick(NOTES) })

/** Items as a save writes them, keyed by their content, then some keys dropped by a hand edit. */
const someKeyed = (g: Gen, items: Item[]): Item[] => {
  const read = entryAsRead(schema, { items: structuredClone(items) }) as Value
  return read.items.map((item) => {
    if (g.next() < 0.5) return item
    const { [ITEM_KEY]: _dropped, ...rest } = item
    return rest
  })
}

/** `items` with a few random edits: values changed, items added, removed, moved and copied. */
const edit = (g: Gen, items: Item[]): Item[] => {
  const out = items.map((item) =>
    g.next() < 0.4
      ? { ...item, [g.pick(['title', 'note'])]: g.pick([...TITLES, ...NOTES]) }
      : structuredClone(item),
  )
  for (let n = g.int(3); n > 0; n--) {
    const r = g.next()
    if (r < 0.3 && out.length > 0) out.splice(g.int(out.length), 1)
    else if (r < 0.6) out.splice(g.int(out.length + 1), 0, fresh(g))
    else if (r < 0.8 && out.length > 1) {
      const [moved] = out.splice(g.int(out.length), 1)
      out.splice(g.int(out.length + 1), 0, moved)
    } else if (out.length > 0) out.push(structuredClone(out[g.int(out.length)]))
  }
  return g.next() < 0.5 ? someKeyed(g, out) : out
}

const SHAS = { ancestor: 'a'.repeat(40), base: 'b'.repeat(40), branch: 'c'.repeat(40) }

/** The cards a real merge of three versions gives, as the API serves them, on the merged form. */
const throughCards = (ancestor: Value, base: Value, branch: Value) => {
  const merged = mergeEntry({
    format: 'json',
    ancestor: { data: ancestor },
    base: { data: base },
    branch: { data: branch },
    fields: schema,
  })
  if (merged.kind !== 'merged') return undefined
  const asServed = (data: Value) => ({
    format: 'json' as const,
    entryType: 'page',
    data: entryAsRead(schema, structuredClone(data)),
  })
  const data: EntryConflictData = {
    contentId: 'pg0000000001',
    kind: 'fields',
    path: 'content/pages/page.home.pg0000000001.json',
    logicalPath: 'content/pages/home',
    mergeSha: 'd'.repeat(40),
    sides: SHAS,
    fields: merged.conflicts.map((c) => ({
      key: c.key,
      drawerKey: c.key,
      dataPath: c.dataPath,
      sidePaths: c.sidePaths,
      kind: c.kind,
      ...(c.item && { item: true as const }),
      mergeSha: 'd'.repeat(40),
      sides: SHAS,
    })),
    versions: {
      [SHAS.ancestor]: asServed(ancestor),
      [SHAS.base]: asServed(base),
      [SHAS.branch]: asServed(branch),
    },
  }
  const saved = entryAsRead(schema, structuredClone(merged.data))
  const conflicts = new Map(merged.conflicts.map((c) => [c.key, c]))
  return { built: buildEntryConflicts(data, schema, undefined, undefined, saved), saved, conflicts }
}

const withoutKey = (item: unknown) => {
  if (item === null || typeof item !== 'object') return item
  const { [ITEM_KEY]: _key, ...rest } = item as Item
  return rest
}

/**
 * What a placed choice did wrong, if anything: it changed an item other than the one holding your
 * value at the place, or more than one.
 */
const misplaced = (
  saved: Item,
  placed: Item,
  field: FieldConflict,
  yours: unknown,
): string | undefined => {
  const before = (saved as Value).items
  const after = (placed as Value).items
  if (field.item && after.length !== before.length) {
    // A whole item taken out, or put back, with every other item as it was.
    const rest = [...after]
    const gone: Item[] = []
    for (const item of before) {
      const at = rest.findIndex((a) => equal(a, item))
      if (at < 0) gone.push(item)
      else rest.splice(at, 1)
    }
    if (after.length < before.length) {
      return gone.length === 1 && equal(withoutKey(gone[0]), withoutKey(yours))
        ? undefined
        : `took out ${JSON.stringify(gone)} for yours ${JSON.stringify(yours)}`
    }
    return gone.length === 0 ? undefined : `put back beside changing ${JSON.stringify(gone)}`
  }
  const changed = before
    .map((item, i) => ({ item, now: after[i] }))
    .filter(({ item, now }) => !equal(item, now))
  if (changed.length === 0) return undefined
  if (changed.length > 1) return 'changed more than one item'
  const place = field.dataPath.at(-1)
  const name = place && 'field' in place ? place.field : undefined
  const held = field.item ? withoutKey(changed[0].item) : name && changed[0].item[name]
  return equal(held, field.item ? withoutKey(yours) : yours)
    ? undefined
    : `changed ${JSON.stringify(changed[0].item)}, which doesn't hold yours ${JSON.stringify(yours)}`
}

const SEEDS = 6000

describe('"Use latest version" over generated merges of duplicate-heavy lists', () => {
  it(`changes only the item the merge named, for ${SEEDS} seeds`, () => {
    const failures: string[] = []
    let placedCount = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const g = generator(seed)
      const ancestorItems = someKeyed(
        g,
        Array.from({ length: 2 + g.int(4) }, () => fresh(g)),
      )
      const ancestor = { items: ancestorItems }
      const base = { items: edit(g, ancestorItems) }
      const branch = { items: edit(g, ancestorItems) }
      const through = throughCards(ancestor, base, branch)
      if (!through) continue
      for (const field of through.built.fields) {
        if (!field.dataPath.some((s) => 'item' in s)) continue
        const placed = withLatest(through.saved, field, undefined)
        if (!placed) continue
        placedCount++
        const yours = through.conflicts.get(field.key)?.branch
        const wrong = misplaced(through.saved, placed, field, yours)
        if (wrong) failures.push(`seed ${seed}, ${field.key}: ${wrong}`)
      }
    }
    expect(placedCount).toBeGreaterThan(100)
    expect(failures).toEqual([])
  }, 60_000)
})
