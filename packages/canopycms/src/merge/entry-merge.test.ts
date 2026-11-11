/**
 * The field merge's conflict cases, one named test per row of the plan's conflict-case table at
 * the engine layer: rows 1-16, 19-26, 32, 34 and 36 here; rows 17, 18, 27 and 28 are the golden
 * fixtures in `entry-merge.golden.test.ts`. Every case also checks the identities
 * `merge(O, A, O) ≡ A` and `merge(O, O, B) ≡ B`, and that no conflict marker reaches the result.
 */

import { describe, expect, it } from 'vitest'

import type { ContentFormat, FieldConfig } from '../config'
import { parseEntryParts } from '../content-listing'
import { computeEntryDiff } from '../editor/entry-diff'
import { itemKeysAsRead } from '../item-keys'
import { entryAsRead } from '../utils/calendar-day'
import { serializeFrontmatter, serializeYaml } from '../utils/content-serialize'
import {
  mergeCollectionMeta,
  mergeEntry,
  type EntryMergeResult,
  type FieldConflict,
  type MergeSide,
} from './entry-merge'

const text = (...names: string[]): FieldConfig[] => names.map((name) => ({ name, type: 'string' }))

const fields: FieldConfig[] = [
  ...text('title', 'subtitle'),
  { name: 'count', type: 'number' },
  {
    name: 'hero',
    type: 'object',
    fields: [...text('heading'), { name: 'cta', type: 'object', fields: text('label', 'href') }],
  },
  { name: 'tags', type: 'string', list: true },
  { name: 'items', type: 'object', list: true, fields: text('title', 'detail') },
  {
    name: 'blocks',
    type: 'block',
    templates: [
      { name: 'hero', fields: text('heading', 'sub') },
      { name: 'quote', fields: text('text', 'by') },
    ],
  },
  { name: 'notes', type: 'markdown' },
  { name: 'body', type: 'markdown', isBody: true },
]

type Data = Record<string, unknown>
type Merged = Extract<EntryMergeResult, { kind: 'merged' }>

const MARKERS = /<{7}|>{7}|={7}|\|{7}/

const run = (
  o: MergeSide,
  a: MergeSide,
  b: MergeSide,
  format: ContentFormat = 'md',
  schema: FieldConfig[] | undefined = fields,
): Merged => {
  const result = mergeEntry({
    format,
    ancestor: o,
    base: a,
    branch: b,
    ...(schema && { fields: schema }),
  })
  if (result.kind !== 'merged') throw new Error(`expected a merge, got ${result.kind}`)
  expect(JSON.stringify(result)).not.toMatch(MARKERS)
  return result
}

/** Asserts the two identities for these three versions. */
const identities = (o: MergeSide, a: MergeSide, b: MergeSide, format: ContentFormat = 'md') => {
  for (const [side, merged] of [
    [a, run(o, a, o, format)],
    [b, run(o, o, b, format)],
  ] as const) {
    expect(merged.conflicts).toEqual([])
    expect(merged.data).toStrictEqual(side.data)
    expect(merged.body).toBe(side.body)
  }
}

/** Merges, checks the identities, and returns the merge. */
const merge = (o: Data, a: Data, b: Data): Merged => {
  identities({ data: o }, { data: a }, { data: b })
  return run({ data: o }, { data: a }, { data: b })
}

const kinds = (result: Merged) =>
  result.conflicts.map(({ key, kind, item }) => ({ key, kind, ...(item && { item }) }))

const item = (key: string, title: string, detail = `${title} detail`) => ({
  title,
  detail,
  _key: key,
})
const keyed = [item('k1', 'One'), item('k2', 'Two'), item('k3', 'Three')]
const titles = (result: Merged, name = 'items') =>
  (result.data[name] as Array<{ title: string }>).map((x) => x.title)

describe('leaves and records', () => {
  it('row 1: disjoint fields edited on each side merge with no conflict', () => {
    const result = merge(
      { title: 'T', subtitle: 'S' },
      { title: 'T2', subtitle: 'S' },
      { title: 'T', subtitle: 'S2' },
    )
    expect(result.data).toEqual({ title: 'T2', subtitle: 'S2' })
    expect(result.conflicts).toEqual([])
  })

  it('row 2: a change on one side is taken, in both directions', () => {
    expect(merge({ title: 'T' }, { title: 'Base' }, { title: 'T' }).data).toEqual({ title: 'Base' })
    expect(merge({ title: 'T' }, { title: 'T' }, { title: 'Mine' }).data).toEqual({ title: 'Mine' })
  })

  it('row 3: the same new value on both sides is no conflict', () => {
    const result = merge({ count: 1 }, { count: 2 }, { count: 2 })
    expect(result.data).toEqual({ count: 2 })
    expect(result.conflicts).toEqual([])
  })

  it('row 4: one scalar changed differently is a conflict, the branch value in the tree', () => {
    const result = merge({ title: 'T' }, { title: 'Base' }, { title: 'Mine' })
    expect(result.data).toEqual({ title: 'Mine' })
    expect(result.conflicts).toEqual([
      {
        key: 'title',
        dataPath: [{ field: 'title' }],
        kind: 'changed',
        ancestor: 'T',
        base: 'Base',
        branch: 'Mine',
      },
    ])
  })

  it('row 5: a conflict deep in a nested object is keyed at the leaf; its siblings merge', () => {
    const o = { hero: { heading: 'H', cta: { label: 'Go', href: '/a' } } }
    const result = merge(
      o,
      { hero: { heading: 'H2', cta: { label: 'Start', href: '/a' } } },
      { hero: { heading: 'H', cta: { label: 'Begin', href: '/b' } } },
    )
    expect(result.data).toEqual({ hero: { heading: 'H2', cta: { label: 'Begin', href: '/b' } } })
    expect(result.conflicts).toEqual([
      {
        key: 'hero.cta.label',
        dataPath: [{ field: 'hero' }, { field: 'cta' }, { field: 'label' }],
        kind: 'changed',
        ancestor: 'Go',
        base: 'Start',
        branch: 'Begin',
      },
    ])
  })

  it('row 6: a key the base deleted and the branch left alone is deleted', () => {
    const result = merge(
      { title: 'T', subtitle: 'S' },
      { title: 'T' },
      { title: 'T2', subtitle: 'S' },
    )
    expect(result.data).toStrictEqual({ title: 'T2' })
    expect(result.conflicts).toEqual([])
  })

  it('row 7: a key the base deleted and the branch changed is a "removed on latest" conflict', () => {
    const result = merge({ subtitle: 'S' }, {}, { subtitle: 'Mine' })
    expect(result.data).toEqual({ subtitle: 'Mine' })
    expect(result.conflicts).toEqual([
      {
        key: 'subtitle',
        dataPath: [{ field: 'subtitle' }],
        kind: 'removed-on-base',
        ancestor: 'S',
        branch: 'Mine',
      },
    ])
  })

  it('row 8: a key the branch deleted and the base changed is a "removed by you" conflict', () => {
    const result = merge(
      { subtitle: 'S', title: 'T' },
      { subtitle: 'Base', title: 'T' },
      { title: 'T' },
    )
    expect(result.data).toStrictEqual({ title: 'T' })
    expect(kinds(result)).toEqual([{ key: 'subtitle', kind: 'removed-by-you' }])
    expect(result.conflicts[0]).toMatchObject({ ancestor: 'S', base: 'Base' })
    expect(result.conflicts[0]).not.toHaveProperty('branch')
  })

  it('row 9: a key and a list the base added are kept exactly, with no keys minted', () => {
    const links = [{ href: '/a' }, { href: '/b', nested: [{ x: 1 }] }]
    const result = merge({ title: 'T' }, { title: 'T', count: 3, links }, { title: 'T2' })
    expect(result.data).toStrictEqual({ title: 'T2', count: 3, links })
    expect(result.conflicts).toEqual([])
  })

  it('row 10: the same key added on both sides with different values is a conflict', () => {
    const result = merge({}, { subtitle: 'Base' }, { subtitle: 'Mine' })
    expect(result.data).toEqual({ subtitle: 'Mine' })
    expect(result.conflicts).toEqual([
      {
        key: 'subtitle',
        dataPath: [{ field: 'subtitle' }],
        kind: 'changed',
        base: 'Base',
        branch: 'Mine',
      },
    ])
  })

  it('row 11: a key outside the schema follows the same rules as a known key', () => {
    const result = merge(
      { legacy: 'L', extra: { a: 1, b: 1 } },
      { legacy: 'Base', extra: { a: 2, b: 1 } },
      { legacy: 'Mine', extra: { a: 1, b: 2 } },
    )
    expect(result.data).toEqual({ legacy: 'Mine', extra: { a: 2, b: 2 } })
    expect(kinds(result)).toEqual([{ key: '?legacy', kind: 'changed' }])
  })
})

describe('lists of records', () => {
  it('row 12: different items of a keyed list edited on each side merge', () => {
    const result = merge(
      { items: keyed },
      { items: [keyed[0], item('k2', 'Two (base)'), keyed[2]] },
      { items: [keyed[0], keyed[1], item('k3', 'Three (mine)')] },
    )
    expect(result.data.items).toEqual([
      keyed[0],
      item('k2', 'Two (base)'),
      item('k3', 'Three (mine)'),
    ])
    expect(result.conflicts).toEqual([])
  })

  it('row 13: the same item and field edited on both sides is a conflict at the item path', () => {
    const result = merge(
      { items: keyed },
      { items: [keyed[0], { ...keyed[1], title: 'Base' }, keyed[2]] },
      { items: [keyed[0], { ...keyed[1], title: 'Mine', detail: 'Mine too' }, keyed[2]] },
    )
    expect(result.data.items).toEqual([
      keyed[0],
      { ...keyed[1], title: 'Mine', detail: 'Mine too' },
      keyed[2],
    ])
    expect(result.conflicts).toEqual([
      {
        key: 'items.k2.title',
        dataPath: [{ field: 'items' }, { item: 'k2' }, { field: 'title' }],
        kind: 'changed',
        ancestor: 'Two',
        base: 'Base',
        branch: 'Mine',
      },
    ])
  })

  it('row 14: an item removed on the base and edited on the branch is an item conflict, kept', () => {
    const edited = { ...keyed[1], title: 'Mine' }
    const result = merge(
      { items: keyed },
      { items: [keyed[0], keyed[2]] },
      { items: [keyed[0], edited, keyed[2]] },
    )
    expect(result.data.items).toEqual([keyed[0], edited, keyed[2]])
    expect(result.conflicts).toEqual([
      {
        key: 'items.k2',
        dataPath: [{ field: 'items' }, { item: 'k2' }],
        kind: 'removed-on-base',
        item: true,
        ancestor: keyed[1],
        branch: edited,
      },
    ])
  })

  it('row 14: an item removed on the branch and edited on the base is an item conflict, gone', () => {
    const edited = { ...keyed[1], title: 'Base' }
    const result = merge(
      { items: keyed },
      { items: [keyed[0], edited, keyed[2]] },
      { items: [keyed[0], keyed[2]] },
    )
    expect(result.data.items).toEqual([keyed[0], keyed[2]])
    expect(result.conflicts).toEqual([
      {
        key: 'items.k2',
        dataPath: [{ field: 'items' }, { item: 'k2' }],
        kind: 'removed-by-you',
        item: true,
        ancestor: keyed[1],
        base: edited,
      },
    ])
  })

  describe('an editor first save that keys an item as read and edits it in the same save', () => {
    const t1 = { title: 'One', detail: 'one' }
    const t2 = { title: 'Two', detail: 'two' }
    const [k1, k2] = itemKeysAsRead([t1, t2]) as string[]

    it('row 12: merges with no conflict, and the base edits to its other fields apply', () => {
      const result = merge(
        { items: [t1, t2] },
        { items: [t1, { ...t2, detail: 'two (base)' }] },
        {
          items: [
            { ...t1, _key: k1 },
            { ...t2, title: 'Two (mine)', _key: k2 },
          ],
        },
      )
      expect(result.data.items).toEqual([
        { ...t1, _key: k1 },
        { title: 'Two (mine)', detail: 'two (base)', _key: k2 },
      ])
      expect(result.conflicts).toEqual([])
    })

    it('row 13: the base editing the same field too is exactly one field conflict', () => {
      const result = merge(
        { items: [t1, t2] },
        { items: [t1, { ...t2, title: 'Two (base)' }] },
        {
          items: [
            { ...t1, _key: k1 },
            { ...t2, title: 'Two (mine)', _key: k2 },
          ],
        },
      )
      expect(result.data.items).toEqual([
        { ...t1, _key: k1 },
        { ...t2, title: 'Two (mine)', _key: k2 },
      ])
      expect(kinds(result)).toEqual([{ key: `items.${k2}.title`, kind: 'changed' }])
    })

    it('row 12: with a bare date in the item and no schema, the key still names the item', () => {
      const day = { title: 'Launch', on: new Date('2026-03-01T00:00:00.000Z') }
      // A read that knows `on` is a date keys the item with the day as text.
      const asRead = itemKeysAsRead([{ title: 'Launch', on: '2026-03-01' }])[0]!
      const result = run(
        { data: { items: [day] } },
        { data: { items: [{ ...day, note: 'base' }] } },
        { data: { items: [{ ...day, title: 'Launch day', _key: asRead }] } },
        'md',
        undefined,
      )
      expect(result.data.items).toEqual([
        { ...day, title: 'Launch day', note: 'base', _key: asRead },
      ])
      expect(result.conflicts).toEqual([])
    })
  })

  it('row 14: an item deleted and a new one added in its place is never read as an edit', () => {
    const edited = { ...keyed[1], title: 'Base' }
    const added = item('Nw3xQ8rT2kLm', 'Brand new')
    const result = merge(
      { items: keyed },
      { items: [keyed[0], edited, keyed[2]] },
      { items: [keyed[0], added, keyed[2]] },
    )
    expect(result.data.items).toEqual([keyed[0], added, keyed[2]])
    expect(kinds(result)).toEqual([{ key: 'items.k2', kind: 'removed-by-you', item: true }])
  })

  it('row 15: an item removed on both sides is removed; items added on both are all kept', () => {
    const result = merge(
      { items: keyed },
      { items: [keyed[0], keyed[2], item('na', 'Base new')] },
      { items: [keyed[0], item('nb', 'My new'), keyed[2]] },
    )
    expect(titles(result)).toEqual(['One', 'My new', 'Three', 'Base new'])
    expect(result.conflicts).toEqual([])
  })

  it('row 15: the same item added alike on both sides is one item', () => {
    const added = { title: 'New', detail: 'Same' }
    const result = merge(
      { items: keyed },
      { items: [...keyed, added] },
      { items: [...keyed, { ...added, _key: 'n1' }] },
    )
    expect(result.data.items).toEqual([...keyed, { ...added, _key: 'n1' }])
    expect(result.conflicts).toEqual([])
  })

  it('row 16: a reorder on one side and an edit on the other both apply, in both directions', () => {
    const reordered = [keyed[2], keyed[0], keyed[1]]
    const edited = [keyed[0], { ...keyed[1], title: 'Edited' }, keyed[2]]
    expect(titles(merge({ items: keyed }, { items: reordered }, { items: edited }))).toEqual([
      'Three',
      'One',
      'Edited',
    ])
    expect(titles(merge({ items: keyed }, { items: edited }, { items: reordered }))).toEqual([
      'Three',
      'One',
      'Edited',
    ])
  })

  it('row 16: a reorder on both sides takes the branch order, with no conflict', () => {
    const result = merge(
      { items: keyed },
      { items: [keyed[1], keyed[0], keyed[2]] },
      { items: [keyed[2], keyed[1], keyed[0]] },
    )
    expect(titles(result)).toEqual(['Three', 'Two', 'One'])
    expect(result.conflicts).toEqual([])
  })

  it('row 19: a keyless list where the base inserts and the branch edits: add + edit', () => {
    const [x, y, z] = [{ title: 'X' }, { title: 'Y' }, { title: 'Z' }]
    const result = merge(
      { items: [x, y, z] },
      { items: [x, { title: 'New' }, y, z] },
      { items: [x, { title: 'Y edited' }, z] },
    )
    expect(result.data.items).toStrictEqual([x, { title: 'New' }, { title: 'Y edited' }, z])
    expect(result.conflicts).toEqual([])
  })

  it('row 19: an unequal gap pairs nothing by position: an insert is never read as an edit', () => {
    const [x, y, z] = [{ title: 'X' }, { title: 'Y' }, { title: 'Z' }]
    const result = merge(
      { items: [x, y, z] },
      { items: [x, { title: 'New' }, { title: 'Y (base)' }, z] },
      { items: [x, { title: 'Y (mine)' }, z] },
    )
    expect(titles(result)).toEqual(['X', 'New', 'Y (base)', 'Y (mine)', 'Z'])
    // The conflict names the item the tree holds, the branch's, by the key a read gives it.
    const mine = itemKeysAsRead([{ title: 'Y (mine)' }])[0]
    expect(kinds(result)).toEqual([{ key: `items.${mine}`, kind: 'removed-on-base', item: true }])
  })

  it('row 20: duplicate identical items, keyed with the -2 suffix, align stably', () => {
    const p = { title: 'P', detail: 'same' }
    const q = { title: 'Q', detail: 'q' }
    const [kp, kp2, kq] = itemKeysAsRead([p, p, q]) as string[]
    expect(kp2).toBe(`${kp}-2`)
    const result = merge(
      { items: [p, p, q] },
      { items: [p, p, { ...q, detail: 'q (base)' }] },
      {
        items: [
          { ...p, _key: kp },
          { ...p, detail: 'second (mine)', _key: kp2 },
          { ...q, _key: kq },
        ],
      },
    )
    expect(result.data.items).toEqual([
      { ...p, _key: kp },
      { ...p, detail: 'second (mine)', _key: kp2 },
      { ...q, detail: 'q (base)', _key: kq },
    ])
    expect(result.conflicts).toEqual([])
  })
})

describe('blocks', () => {
  const hero = (heading: string, sub = 'S') => ({
    template: 'hero',
    value: { heading, sub },
    _key: 'b1',
  })
  const quote = { template: 'quote', value: { text: 'Q', by: 'A' }, _key: 'b2' }

  it('row 21: a template changed on one side and data on the other is an item conflict', () => {
    const result = merge(
      { blocks: [hero('H'), quote] },
      { blocks: [{ template: 'quote', value: { text: 'Was a hero' }, _key: 'b1' }, quote] },
      { blocks: [hero('Mine'), quote] },
    )
    expect(result.data.blocks).toEqual([hero('Mine'), quote])
    expect(kinds(result)).toEqual([{ key: 'blocks.b1', kind: 'changed', item: true }])
    expect(result.conflicts[0].dataPath).toEqual([{ field: 'blocks' }, { item: 'b1' }])
  })

  it('row 21: the same template merges by field, with a conflict named through its data', () => {
    const result = merge(
      { blocks: [hero('H'), quote] },
      { blocks: [hero('Base', 'S2'), quote] },
      { blocks: [hero('Mine'), quote] },
    )
    expect(result.data.blocks).toEqual([hero('Mine', 'S2'), quote])
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        key: 'blocks.b1.heading',
        dataPath: [{ field: 'blocks' }, { item: 'b1' }, { blockData: true }, { field: 'heading' }],
        kind: 'changed',
      }),
    ])
  })

  it('row 21: the inline _type shape: a changed type conflicts, the same type merges', () => {
    const inline = (type: string, heading: string, sub = 'S') => ({
      _type: type,
      heading,
      sub,
      _key: 'b1',
    })
    const changed = merge(
      { blocks: [inline('hero', 'H')] },
      { blocks: [inline('quote', 'H')] },
      { blocks: [inline('hero', 'Mine')] },
    )
    expect(kinds(changed)).toEqual([{ key: 'blocks.b1', kind: 'changed', item: true }])
    const same = merge(
      { blocks: [inline('hero', 'H')] },
      { blocks: [inline('hero', 'Base', 'S2')] },
      { blocks: [inline('hero', 'Mine')] },
    )
    expect(same.data.blocks).toEqual([inline('hero', 'Mine', 'S2')])
    expect(same.conflicts.map((c) => [c.key, c.dataPath])).toEqual([
      [
        'blocks.b1.heading',
        [{ field: 'blocks' }, { item: 'b1' }, { blockData: true }, { field: 'heading' }],
      ],
    ])
  })
})

describe('lists of plain values', () => {
  it('row 22: disjoint adds to a tag list merge, and adds at one place keep both', () => {
    expect(
      merge(
        { tags: ['a', 'b', 'c'] },
        { tags: ['n1', 'a', 'b', 'c'] },
        { tags: ['a', 'b', 'c', 'n2'] },
      ).data,
    ).toEqual({
      tags: ['n1', 'a', 'b', 'c', 'n2'],
    })
    const both = merge(
      { tags: ['a'] },
      { tags: ['a', 'base', 'same'] },
      { tags: ['a', 'same', 'mine'] },
    )
    expect(both.data).toEqual({ tags: ['a', 'base', 'same', 'mine'] })
    expect(both.conflicts).toEqual([])
  })

  it('row 22: overlapping edits to a tag list are one whole-field conflict', () => {
    const result = merge(
      { tags: ['a', 'b', 'c'] },
      { tags: ['a', 'X', 'c'] },
      { tags: ['a', 'Y', 'c'] },
    )
    expect(result.data).toEqual({ tags: ['a', 'Y', 'c'] })
    expect(result.conflicts).toEqual([
      {
        key: 'tags',
        dataPath: [{ field: 'tags' }],
        kind: 'changed',
        ancestor: ['a', 'b', 'c'],
        base: ['a', 'X', 'c'],
        branch: ['a', 'Y', 'c'],
      },
    ])
  })
})

describe('long text and the body', () => {
  const lines = (...xs: string[]) => `${xs.join('\n')}\n`
  const body = (o: string, a: string, b: string) => {
    identities({ data: {}, body: o }, { data: {}, body: a }, { data: {}, body: b })
    return run({ data: {}, body: o }, { data: {}, body: a }, { data: {}, body: b })
  }

  it('row 23: different paragraphs of the body merge', () => {
    const result = body(
      lines('p1', '', 'p2', '', 'p3'),
      lines('P1', '', 'p2', '', 'p3'),
      lines('p1', '', 'p2', '', 'P3'),
    )
    expect(result.body).toBe(lines('P1', '', 'p2', '', 'P3'))
    expect(result.conflicts).toEqual([])
  })

  it('row 23: the same lines changed differently are a region conflict, the branch lines kept', () => {
    const result = body(lines('p1', '', 'p2'), lines('p1', '', 'base'), lines('P1', '', 'mine'))
    expect(result.body).toBe(lines('P1', '', 'mine'))
    expect(result.conflicts).toEqual([
      {
        key: 'body',
        dataPath: [{ field: 'body' }],
        kind: 'changed',
        ancestor: lines('p1', '', 'p2'),
        base: lines('p1', '', 'base'),
        branch: lines('P1', '', 'mine'),
        regions: [{ ancestor: 'p2', base: 'base', branch: 'mine', line: 2, lines: 1 }],
      },
    ])
  })

  it('row 23: changes to adjacent lines are one conflict region, as in git', () => {
    const result = body(lines('a', 'b', 'c'), lines('a', 'B', 'c'), lines('a', 'b', 'C'))
    expect(result.body).toBe(lines('a', 'b', 'C'))
    expect(result.conflicts[0].regions).toEqual([
      { ancestor: 'b\nc', base: 'B\nc', branch: 'b\nC', line: 1, lines: 2 },
    ])
  })

  it('row 23: identical edits on both sides merge cleanly', () => {
    // The same edit at line 2, and the base alone changed line 4: the line merge decides.
    const result = body(
      lines('a', 'b', 'c', 'd', 'e'),
      lines('a', 'B', 'new', 'c', 'D', 'e'),
      lines('a', 'B', 'new', 'c', 'd', 'e'),
    )
    expect(result.body).toBe(lines('a', 'B', 'new', 'c', 'D', 'e'))
    expect(result.conflicts).toEqual([])
  })

  it('row 24: several regions in one body are one conflict with a region each, in order', () => {
    const result = body(
      lines('one', '', 'two', '', 'three', '', 'four'),
      lines('ONE', '', 'two', '', 'three', '', 'FOUR'),
      lines('uno', '', 'two', '', 'THREE', '', 'cuatro'),
    )
    expect(result.body).toBe(lines('uno', '', 'two', '', 'THREE', '', 'cuatro'))
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].regions).toEqual([
      { ancestor: 'one', base: 'ONE', branch: 'uno', line: 0, lines: 1 },
      { ancestor: 'four', base: 'FOUR', branch: 'cuatro', line: 6, lines: 1 },
    ])
    // "Use both" is the latest version's lines, then yours.
    const [first] = result.conflicts[0].regions ?? []
    expect(`${first.base}\n${first.branch}`).toBe('ONE\nuno')
  })

  it('row 25: an mdx body that merges by line but does not parse is one whole-body conflict', () => {
    // The base drops the wrapper; the branch widens it. Each parses, the line merge does not.
    const o = lines('<Note>', 'inside', '</Note>', 'outside one', 'outside two')
    const a = lines('inside', 'outside one', 'outside two')
    const b = lines('<Note>', 'inside', 'outside one', 'outside two', '</Note>')
    const md = run({ data: {}, body: o }, { data: {}, body: a }, { data: {}, body: b }, 'md')
    expect(md.body).toBe(lines('inside', 'outside one', 'outside two', '</Note>'))
    expect(md.conflicts).toEqual([])
    const result = run({ data: {}, body: o }, { data: {}, body: a }, { data: {}, body: b }, 'mdx')
    expect(result.body).toBe(b)
    expect(result.conflicts).toEqual([
      {
        key: 'body',
        dataPath: [{ field: 'body' }],
        kind: 'changed',
        ancestor: o,
        base: a,
        branch: b,
        unparseable: true,
      },
    ])
  })

  it('row 26: a multi-line frontmatter string merges by line', () => {
    const result = merge(
      { notes: 'line 1\nline 2\nline 3\n' },
      { notes: 'LINE 1\nline 2\nline 3\n' },
      { notes: 'line 1\nline 2\nLINE 3\n' },
    )
    expect(result.data).toEqual({ notes: 'LINE 1\nline 2\nLINE 3\n' })
    expect(result.conflicts).toEqual([])
  })

  it('row 26: a difference only in the line break at the end is no conflict', () => {
    const result = merge({ notes: 'a\nb\n' }, { notes: 'a\nb' }, { notes: 'a\nB\n' })
    expect(result.data).toEqual({ notes: 'a\nB' })
    expect(result.conflicts).toEqual([])
  })
})

describe('entry type', () => {
  const typed = (entryType: string, data: Data): MergeSide => ({ entryType, data })

  it('row 32: an entry type changed on one side and the content on the other is an entry conflict', () => {
    const o = typed('post', { title: 'T' })
    expect(
      mergeEntry({
        format: 'json',
        ancestor: o,
        base: typed('page', { title: 'T' }),
        branch: typed('post', { title: 'Mine' }),
      }),
    ).toEqual({
      kind: 'entry-conflict',
      reason: 'entry-type',
    })
    expect(
      mergeEntry({
        format: 'json',
        ancestor: o,
        base: typed('post', { title: 'Base' }),
        branch: typed('page', { title: 'T' }),
      }),
    ).toEqual({
      kind: 'entry-conflict',
      reason: 'entry-type',
    })
  })

  it('row 32: a type changed on one side alone, or alike on both, merges', () => {
    const o = typed('post', { title: 'T', count: 1 })
    expect(
      mergeEntry({
        format: 'json',
        ancestor: o,
        base: typed('page', { title: 'Retitled', count: 1 }),
        branch: o,
      }),
    ).toMatchObject({
      kind: 'merged',
      data: { title: 'Retitled', count: 1 },
      conflicts: [],
    })
    expect(
      mergeEntry({
        format: 'json',
        ancestor: o,
        base: typed('page', { title: 'Base', count: 1 }),
        branch: typed('page', { title: 'T', count: 2 }),
      }),
    ).toMatchObject({ kind: 'merged', data: { title: 'Base', count: 2 }, conflicts: [] })
  })
})

describe('collection meta', () => {
  it('row 34: concurrent inserts into order merge as a set, and entries match by name', () => {
    const entry = (name: string, label: string) => ({ name, label, format: 'md', schema: 's' })
    const result = mergeCollectionMeta(
      {
        name: 'posts',
        order: ['id1', 'id2'],
        entries: [entry('post', 'Post'), entry('page', 'Page')],
      },
      {
        name: 'posts',
        order: ['id1', 'idA', 'id2'],
        entries: [entry('page', 'Page'), entry('post', 'Article')],
      },
      {
        name: 'posts',
        order: ['id2', 'id1', 'idB'],
        entries: [entry('post', 'Post'), entry('page', 'Landing page'), entry('faq', 'FAQ')],
      },
    )
    expect(result.conflicts).toEqual([])
    expect(result.data).toEqual({
      name: 'posts',
      order: ['id2', 'id1', 'idA', 'idB'],
      // The base reordered the entries and the branch did not, so the base's order leads.
      entries: [entry('page', 'Landing page'), entry('faq', 'FAQ'), entry('post', 'Article')],
    })
  })

  it('row 34: an id removed from order on one side is removed', () => {
    const result = mergeCollectionMeta(
      { order: ['a', 'b', 'c'] },
      { order: ['a', 'c'] },
      { order: ['a', 'b', 'c', 'd'] },
    )
    expect(result.data).toEqual({ order: ['a', 'c', 'd'] })
  })
})

describe('row 36: every format round-trips through the merge and its serializer', () => {
  const md = (title: string, para: string) =>
    `---\ntitle: ${title}\ncount: 1\n---\nIntro.\n\n${para}\n`
  const cases: Array<
    [
      ContentFormat,
      string,
      string,
      string,
      (data: Data, body: string | undefined, raw: string) => string,
    ]
  > = [
    [
      'md',
      md('T', 'P'),
      md('Base', 'P'),
      md('T', 'Mine'),
      (d, b, raw) => serializeFrontmatter(b ?? '', d, raw, 'md', fields),
    ],
    [
      'mdx',
      md('T', 'P'),
      md('Base', 'P'),
      md('T', '<Mine />'),
      (d, b, raw) => serializeFrontmatter(b ?? '', d, raw, 'mdx', fields),
    ],
    [
      'json',
      '{\n  "title": "T",\n  "count": 1\n}\n',
      '{\n  "title": "Base",\n  "count": 1\n}\n',
      '{\n  "title": "T",\n  "count": 2\n}\n',
      (d) => `${JSON.stringify(d, null, 2)}\n`,
    ],
    [
      'yaml',
      'title: T\ncount: 1\n',
      'title: Base\ncount: 1\n',
      'title: T\ncount: 2\n',
      (d, _b, raw) => serializeYaml(d, raw),
    ],
  ]
  for (const [format, o, a, b, serialize] of cases) {
    it(`${format}`, () => {
      const side = (raw: string): MergeSide => {
        const { data, body } = parseEntryParts(raw, format)
        return { data, ...(body !== undefined && { body }) }
      }
      const result = run(side(o), side(a), side(b), format)
      expect(result.conflicts).toEqual([])
      const written = serialize(result.data, result.body, a)
      const reread = parseEntryParts(written, format)
      expect(reread.data).toEqual(result.data)
      expect(reread.body).toBe(result.body)
      expect(result.data.title).toBe('Base')
    })
  }
})

describe('conflict names agree with the "Show changes" drawer', () => {
  /** The drawer's change for the branch's side of `conflict`. */
  const drawerChange = (o: Data, b: Data, conflict: FieldConflict) =>
    computeEntryDiff({
      fields,
      before: { format: 'json', entryType: 'page', data: entryAsRead(fields, o) },
      after: { format: 'json', entryType: 'page', data: entryAsRead(fields, b) },
      marks: false,
    }).changes.find((change) => change.key === conflict.key)

  const cases: Array<[string, Data, Data, Data]> = [
    [
      'a nested field',
      { hero: { cta: { label: 'Go' } } },
      { hero: { cta: { label: 'B' } } },
      { hero: { cta: { label: 'M' } } },
    ],
    [
      'a keyed item field',
      { items: keyed },
      { items: [{ ...keyed[0], title: 'B' }] },
      { items: [{ ...keyed[0], title: 'M' }] },
    ],
    [
      'a field of an item the base left keyless',
      { items: [{ title: 'T', detail: 'd' }] },
      { items: [{ title: 'B', detail: 'd' }] },
      {
        items: [
          { title: 'M', detail: 'd', _key: itemKeysAsRead([{ title: 'T', detail: 'd' }])[0] },
        ],
      },
    ],
    [
      'a block field',
      { blocks: [{ template: 'hero', value: { heading: 'H' }, _key: 'b1' }] },
      { blocks: [{ template: 'hero', value: { heading: 'B' }, _key: 'b1' }] },
      { blocks: [{ template: 'hero', value: { heading: 'M' }, _key: 'b1' }] },
    ],
    ['a key outside the schema', { legacy: 'L' }, { legacy: 'B' }, { legacy: 'M' }],
  ]
  for (const [name, o, a, b] of cases) {
    it(name, () => {
      const result = run({ data: o }, { data: a }, { data: b })
      expect(result.conflicts).toHaveLength(1)
      const change = drawerChange(o, b, result.conflicts[0])
      expect(change?.key).toBe(result.conflicts[0].key)
      expect(change?.dataPath).toEqual(result.conflicts[0].dataPath)
    })
  }
})
