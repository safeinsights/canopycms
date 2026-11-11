/**
 * The field merge's conflict cases, at least one named test per row of the plan's conflict-case
 * table at the engine layer: rows 1-16, 19-26, 32, 34 and 36 here; rows 17, 18, 27 and 28 are the
 * golden fixtures in `entry-merge.golden.test.ts`. Every case checks that no conflict marker
 * reaches the result. Cases built with `merge` also check the identities `merge(O, A, O) ≡ A` and
 * `merge(O, O, B) ≡ B`; those built with `run` skip them, where a side drops keys the merge
 * carries or the case needs its own schema.
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
  { name: 'snippet', type: 'mdx' },
  { name: 'cover', type: 'image' },
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
        regions: [
          { ancestor: 'p2', base: 'base', branch: 'mine', line: 2, lines: 1, baseLines: 1 },
        ],
      },
    ])
  })

  it('row 23: changes to adjacent lines are one conflict region, as in git', () => {
    const result = body(lines('a', 'b', 'c'), lines('a', 'B', 'c'), lines('a', 'b', 'C'))
    expect(result.body).toBe(lines('a', 'b', 'C'))
    expect(result.conflicts[0].regions).toEqual([
      { ancestor: 'b\nc', base: 'B\nc', branch: 'b\nC', line: 1, lines: 2, baseLines: 2 },
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
      { ancestor: 'one', base: 'ONE', branch: 'uno', line: 0, lines: 1, baseLines: 1 },
      { ancestor: 'four', base: 'FOUR', branch: 'cuatro', line: 6, lines: 1, baseLines: 1 },
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

describe('shapes the review found', () => {
  const kx = { _key: 'Kx7Pq2Lm9Zr4', t: 'X' }
  const ky = { _key: 'Ky3Wd8Hn5Tb1', t: 'Y', url: '/y' }

  it('row 14: a keyed item the base replaced by a keyless one is never read as an edit', () => {
    const z = { t: 'Z', url: '/z' }
    const result = merge(
      { items: [kx, ky] },
      { items: [kx, z] },
      { items: [kx, { ...ky, note: 'mine' }] },
    )
    expect(result.data.items).toEqual([kx, z, { ...ky, note: 'mine' }])
    expect(kinds(result)).toEqual([
      { key: `items.${ky._key}`, kind: 'removed-on-base', item: true },
    ])
    expect(result.keyRemaps).toEqual([])
  })

  it('row 14: the same, with the base item carrying its own content key', () => {
    const z = { t: 'Z', url: '/z' }
    const zKeyed = { ...z, _key: itemKeysAsRead([z])[0]! }
    const result = merge(
      { items: [kx, ky] },
      { items: [kx, zKeyed] },
      { items: [kx, { ...ky, url: '/y2' }] },
    )
    expect(result.data.items).toEqual([kx, zKeyed, { ...ky, url: '/y2' }])
    expect(kinds(result)).toEqual([
      { key: `items.${ky._key}`, kind: 'removed-on-base', item: true },
    ])
    expect(result.keyRemaps).toEqual([])
  })

  it('row 14: a copy carrying a key another item holds is a new item, not an edit', () => {
    const y2 = { ...ky, t: 'Y (base)' }
    const copy = { ...kx, t: 'X copy' }
    const result = merge({ items: [kx, ky] }, { items: [kx, y2] }, { items: [kx, copy] })
    expect(result.data.items).toEqual([kx, copy])
    expect(kinds(result)).toEqual([{ key: `items.${ky._key}`, kind: 'removed-by-you', item: true }])
  })

  it('row 14: in a keyless list, a new item added where the branch deleted one is not that item', () => {
    const [x, y, z] = [{ t: 'x' }, { t: 'y' }, { t: 'z' }]
    const [hx, hz] = [itemKeysAsRead([x])[0]!, itemKeysAsRead([z])[0]!]
    const added = { t: 'new', _key: 'Nw3xQ8rT2kLm' }
    const result = merge(
      { items: [x, y, z] },
      { items: [x, { t: 'y (base)' }, z] },
      { items: [{ ...x, _key: hx }, added, { ...z, _key: hz }] },
    )
    expect(result.data.items).toEqual([{ ...x, _key: hx }, added, { ...z, _key: hz }])
    expect(kinds(result)).toEqual([
      { key: `items.${itemKeysAsRead([y])[0]}`, kind: 'removed-by-you', item: true },
    ])
  })

  it('row 14: in a keyless list, a copy carrying its original key is a new item', () => {
    const [x, y] = [{ t: 'x' }, { t: 'y' }]
    const hx = itemKeysAsRead([x])[0]!
    const copy = { t: 'x copy', _key: hx }
    const result = merge(
      { items: [x, y] },
      { items: [x, { t: 'y (base)' }] },
      { items: [{ ...x, _key: hx }, copy] },
    )
    expect(result.data.items).toEqual([{ ...x, _key: hx }, copy])
    expect(kinds(result)).toEqual([
      { key: `items.${itemKeysAsRead([y])[0]}`, kind: 'removed-by-you', item: true },
    ])
  })

  it('row 16: an item the base moved in a keyless list keeps the branch key and edit', () => {
    const [x, y, z] = [{ t: 'x' }, { t: 'y' }, { t: 'z' }]
    const [hx, hy, hz] = itemKeysAsRead([x, y, z]) as string[]
    const keysOnly = merge(
      { items: [x, y, z] },
      { items: [z, x, y] },
      {
        items: [
          { ...x, _key: hx },
          { ...y, _key: hy },
          { ...z, _key: hz },
        ],
      },
    )
    expect(keysOnly.data.items).toEqual([
      { ...z, _key: hz },
      { ...x, _key: hx },
      { ...y, _key: hy },
    ])
    expect(keysOnly.conflicts).toEqual([])
    const edited = merge(
      { items: [x, y, z] },
      { items: [z, x, y] },
      {
        items: [
          { ...x, _key: hx },
          { ...y, _key: hy },
          { t: 'z2', _key: hz },
        ],
      },
    )
    expect(edited.data.items).toEqual([
      { t: 'z2', _key: hz },
      { ...x, _key: hx },
      { ...y, _key: hy },
    ])
    expect(edited.conflicts).toEqual([])
  })

  it('row 15: two additions that read alike but carry minted keys are two items', () => {
    const [a, b] = [
      { t: 'a', _key: 'Ka1' },
      { t: 'b', _key: 'Kb1' },
    ]
    const top = { t: 'spacer', _key: 'Mint1aaaaaaa' }
    const bottom = { t: 'spacer', _key: 'Mint2bbbbbbb' }
    const result = merge({ items: [a, b] }, { items: [top, a, b] }, { items: [a, b, bottom] })
    expect(result.data.items).toEqual([top, a, b, bottom])
    expect(result.keyRemaps).toEqual([])
  })

  it('row 22: inserts at one place keep the branch duplicates and order', () => {
    expect(merge({ tags: ['a'] }, { tags: ['a', 'x'] }, { tags: ['a', 'x', 'x'] }).data).toEqual({
      tags: ['a', 'x', 'x'],
    })
    expect(
      merge({ tags: ['a', 'b'] }, { tags: ['a', 'x', 'b'] }, { tags: ['a', 'y', 'x', 'b'] }).data,
    ).toEqual({
      tags: ['a', 'y', 'x', 'b'],
    })
    expect(
      merge({ tags: ['a'] }, { tags: ['a', 'p', 'q'] }, { tags: ['a', 'q', 'r', 'q'] }).data,
    ).toEqual({
      tags: ['a', 'p', 'q', 'r', 'q'],
    })
  })

  it('row 22: a 4,000-tag list with many repeats merges quickly', () => {
    const tags = Array.from({ length: 4000 }, (_, i) => `t${i % 10}`)
    const base = tags.map((t, i) => (i === 100 ? 'base' : t))
    const mine = tags.map((t, i) => (i === 3000 ? 'mine' : t))
    const started = performance.now()
    const result = merge({ tags }, { tags: base }, { tags: mine })
    expect(performance.now() - started).toBeLessThan(3000)
    expect(result.data.tags).toEqual(
      tags.map((t, i) => (i === 100 ? 'base' : i === 3000 ? 'mine' : t)),
    )
  })

  it('row 25: an mdx field that merges by line but does not parse is one whole conflict', () => {
    const lines = (...xs: string[]) => `${xs.join('\n')}\n`
    const o = lines('<Note>', 'inside', '</Note>', 'outside one', 'outside two')
    const a = lines('inside', 'outside one', 'outside two')
    const b = lines('<Note>', 'inside', 'outside one', 'outside two', '</Note>')
    const result = merge({ snippet: o }, { snippet: a }, { snippet: b })
    expect(result.data).toEqual({ snippet: b })
    expect(result.conflicts).toEqual([
      {
        key: 'snippet',
        dataPath: [{ field: 'snippet' }],
        kind: 'changed',
        ancestor: o,
        base: a,
        branch: b,
        unparseable: true,
      },
    ])
    // A markdown field is not parsed as mdx: its line merge stands.
    expect(merge({ notes: o }, { notes: a }, { notes: b }).conflicts).toEqual([])
  })

  it('row 34: a name the entries repeat is matched by its occurrence, and nothing doubles', () => {
    const entries = [
      { name: 'a', x: 1 },
      { name: 'a', x: 2 },
    ]
    expect(mergeCollectionMeta({ entries }, { entries, title: 'T' }, { entries }).data).toEqual({
      entries,
      title: 'T',
    })
  })

  it('reads and writes members named like Object.prototype ones as plain members', () => {
    const result = merge(
      { constructor: 'x', title: 't' },
      { constructor: 'x', title: 't' },
      { title: 't' },
    )
    expect(result.data).toStrictEqual({ title: 't' })
    const proto = JSON.parse('{"__proto__": "o", "title": "t"}') as Data
    const mine = JSON.parse('{"__proto__": "mine", "title": "t"}') as Data
    const merged = merge(proto, proto, mine)
    expect(Object.getPrototypeOf(merged.data)).toBe(Object.prototype)
    expect(Object.getOwnPropertyDescriptor(merged.data, '__proto__')?.value).toBe('mine')
  })
})

describe('shapes the second review found', () => {
  it('row 20: a key the ancestor repeats: the branch deleting the copy deletes it', () => {
    const x = { t: 'x', _key: 'Kq1w2e3r4t5y' }
    const result = merge(
      { title: 'T', l: [x, x] },
      { title: 'T2', l: [x, x] },
      { title: 'T', l: [x] },
    )
    expect(result.data).toEqual({ title: 'T2', l: [x] })
    expect(result.conflicts).toEqual([])
  })

  it('row 20: a key the ancestor repeats: the base deleting one item never doubles the other', () => {
    const [x, y] = [
      { t: 'x', _key: 'Kq1w2e3r4t5y' },
      { t: 'y', _key: 'Kq1w2e3r4t5y' },
    ]
    const result = merge({ l: [x, y] }, { l: [y] }, { l: [x, y], title: 'mine' })
    expect((result.data.l as unknown[]).length).toBeLessThanOrEqual(1)
  })

  it('row 15: four items added alike on both sides with one shared key stay four', () => {
    const added = ['a', 'b', 'c', 'd'].map((t) => ({ t, _key: 'Mshared12345' }))
    const result = merge({ l: [] }, { l: added }, { l: added })
    expect(result.data.l).toEqual(added)
  })

  const listsSchema: FieldConfig[] = [
    { name: 'p', type: 'object', list: true, fields: text('t') },
    { name: 'q', type: 'object', list: true, fields: text('t') },
    {
      name: 'blocks',
      type: 'block',
      templates: [
        {
          name: 'hero',
          fields: [
            ...text('heading'),
            { name: 'items', type: 'object', list: true, fields: text('t') },
          ],
        },
      ],
    },
  ]
  const i1 = { t: 'one', _key: 'Ki1aaaaaaaaa' }

  it('row 14: an item the base moved to another list and the branch deleted is a conflict', () => {
    const block = (key: string, items: unknown[]) => ({
      template: 'hero',
      value: { heading: key, items },
      _key: key,
    })
    const result = run(
      { data: { blocks: [block('b1', [i1]), block('b2', [])] } },
      { data: { blocks: [block('b1', []), block('b2', [i1])] } },
      { data: { blocks: [block('b1', []), block('b2', [])] } },
      'md',
      listsSchema,
    )
    expect(kinds(result)).toEqual([
      { key: `blocks.b2.items.${i1._key}`, kind: 'removed-by-you', item: true },
    ])
  })

  it('row 14: an item the branch moved to another list and the base deleted is a conflict', () => {
    const result = run(
      { data: { p: [i1], q: [] } },
      { data: { p: [], q: [] } },
      { data: { p: [], q: [i1] } },
      'md',
      listsSchema,
    )
    expect(result.data).toEqual({ p: [], q: [i1] })
    expect(kinds(result)).toEqual([{ key: `q.${i1._key}`, kind: 'removed-on-base', item: true }])
  })

  it('row 14: an item one side moved and the other changed in place is flagged where it doubles', () => {
    const result = run(
      { data: { p: [i1], q: [] } },
      { data: { p: [], q: [i1] } },
      { data: { p: [{ ...i1, t: 'mine' }], q: [] } },
      'md',
      listsSchema,
    )
    expect(kinds(result)).toEqual([
      { key: `p.${i1._key}`, kind: 'removed-on-base', item: true },
      { key: `q.${i1._key}`, kind: 'changed', item: true },
    ])
  })

  it('row 14: without a schema, a moved-away conflict is lifted to its list with whole versions', () => {
    const result = run(
      { data: { p: [i1], q: [] } },
      { data: { p: [], q: [] } },
      { data: { p: [], q: [i1] } },
      'md',
      undefined,
    )
    expect(result.conflicts).toEqual([
      {
        key: '?q',
        dataPath: [{ field: 'q' }],
        kind: 'removed-on-base',
        ancestor: [],
        base: [],
        branch: [i1],
      },
    ])
  })

  it('row 16: a keyless item the base moved up while the branch deleted it stays deleted', () => {
    const [x, y, z] = [{ title: 'X' }, { title: 'Y' }, { title: 'Z' }]
    const [hy, hz] = [itemKeysAsRead([y])[0]!, itemKeysAsRead([z])[0]!]
    const result = merge(
      { items: [x, y, z] },
      { items: [y, x] },
      {
        items: [
          { ...y, _key: hy },
          { ...z, _key: hz },
        ],
      },
    )
    expect(result.data.items).toEqual([{ ...y, _key: hy }])
    expect(result.conflicts).toEqual([])
  })

  it('row 16: a base that dropped the keys and reordered keeps the branch deletion', () => {
    const [x, y] = [
      { t: 'x', _key: 'Kx7Pq2Lm9Zr4' },
      { t: 'y', _key: 'Ky3Wd8Hn5Tb1' },
    ]
    // Keys are carried, so merge(O, A, O) keeps the keys this base dropped: no identity check.
    const result = run(
      { data: { items: [x, y] } },
      { data: { items: [{ t: 'y' }, { t: 'x' }] } },
      { data: { items: [y] } },
    )
    expect(result.data.items).toEqual([y])
    expect(result.conflicts).toEqual([])
  })

  it('row 14: a pasted copy of an item in the place of a deleted one is a new item', () => {
    const [x, y] = [
      { title: 'x', detail: 'one' },
      { title: 'y', detail: 'one' },
    ]
    const hx = itemKeysAsRead([x])[0]!
    const result = merge(
      { items: [x, y] },
      { items: [x, { ...y, title: 'y (base)' }] },
      {
        items: [
          { ...x, _key: hx },
          { ...x, _key: hx },
        ],
      },
    )
    expect(result.data.items).toEqual([
      { ...x, _key: hx },
      { ...x, _key: hx },
    ])
    expect(kinds(result)).toEqual([
      { key: `items.${itemKeysAsRead([y])[0]}`, kind: 'removed-by-you', item: true },
    ])
  })

  it('row 19: an item the base replaced in place, keeping none of its values, is one conflict', () => {
    const q = { title: 'q', detail: '2' }
    const s1 = { title: 's', detail: '1' }
    const [hq, hs] = itemKeysAsRead([q, s1]) as string[]
    const result = merge(
      { items: [q, s1] },
      { items: [{ title: 'new', detail: '9' }, s1] },
      {
        items: [
          { ...q, detail: 'e4', _key: hq },
          { ...s1, _key: hs },
        ],
      },
    )
    expect(result.data.items).toEqual([
      { ...q, detail: 'e4', _key: hq },
      { ...s1, _key: hs },
    ])
    expect(kinds(result)).toEqual([{ key: `items.${hq}`, kind: 'changed', item: true }])
  })

  it('KNOWN LIMIT, row 19: a keyless item the base replaced in place, sharing one value, merges field by field', () => {
    // Pairing keyless items by position is the engine's one heuristic. A replacement that keeps a
    // value of the item it replaced cannot be told from an edit, so the branch's edit lands on
    // it. Keys everywhere (the key backfill) remove the case.
    const q = { title: 'q', detail: '2' }
    const hq = itemKeysAsRead([q])[0]!
    const result = merge(
      { items: [q] },
      { items: [{ title: 'replacement', detail: '2' }] },
      { items: [{ ...q, detail: 'mine', _key: hq }] },
    )
    expect(result.data.items).toEqual([{ title: 'replacement', detail: 'mine', _key: hq }])
    expect(result.conflicts).toEqual([])
  })

  it('row 22: a tag both sides added at different places is one tag', () => {
    expect(merge({ tags: ['a'] }, { tags: ['a', 'b'] }, { tags: ['b', 'a'] }).data).toEqual({
      tags: ['b', 'a'],
    })
    // Kept at its first place in the merged list, whichever side put it there.
    expect(merge({ tags: ['a'] }, { tags: ['b', 'a'] }, { tags: ['a', 'b'] }).data).toEqual({
      tags: ['b', 'a'],
    })
  })

  it('row 22: a tag deleted on one side and emptied on the other conflicts either way round', () => {
    const one = merge({ tags: ['a', 'b', 'c'] }, { tags: ['a', 'c'] }, { tags: ['a', null, 'c'] })
    const other = merge({ tags: ['a', 'b', 'c'] }, { tags: ['a', null, 'c'] }, { tags: ['a', 'c'] })
    expect(kinds(one)).toEqual([{ key: 'tags', kind: 'changed' }])
    expect(kinds(other)).toEqual([{ key: 'tags', kind: 'changed' }])
  })

  it('row 10: lists both sides added with different kinds of element are one conflict', () => {
    const result = merge({}, { x: ['tag'] }, { x: [{ t: 1 }] })
    expect(result.data).toEqual({ x: [{ t: 1 }] })
    expect(kinds(result)).toEqual([{ key: '?x', kind: 'changed' }])
  })

  it('row 34: entries with no name, or a repeated name, merge as one value', () => {
    const unnamed = { entries: [{ label: 'a' }] }
    expect(mergeCollectionMeta(unnamed, { ...unnamed, title: 'T' }, { entries: [] }).data).toEqual({
      entries: [],
      title: 'T',
    })
    const repeated = [
      { name: 'a', x: 1 },
      { name: 'a', x: 2 },
    ]
    const result = mergeCollectionMeta(
      { entries: repeated },
      { entries: [repeated[1]] },
      { entries: [repeated[0]] },
    )
    expect(result.conflicts.map((c) => c.key)).toEqual(['?entries'])
  })

  it('reads a __proto__ member as a member when deciding an item changed', () => {
    const k1 = JSON.parse('{"__proto__": "one", "t": "x", "_key": "K1aaaaaaaaaa"}') as Data
    const k1Mine = JSON.parse('{"__proto__": "two", "t": "x", "_key": "K1aaaaaaaaaa"}') as Data
    const result = merge({ items: [k1] }, { items: [] }, { items: [k1Mine] })
    expect(result.conflicts.map((c) => c.kind)).toEqual(['removed-on-base'])
  })

  it('a conflicted text keeps the branch end line break', () => {
    const result = merge({ notes: 'b\n\n' }, { notes: '' }, { notes: 'a\n\n' })
    expect(result.data).toEqual({ notes: 'a\n\n' })
  })
})

describe('shapes the third review found', () => {
  it('row 20: identical keyless items: the branch deleting the second copy deletes it', () => {
    const dup = { title: 'TBD', detail: 'x' }
    const b = { title: 'B', detail: 'b' }
    const result = merge(
      { items: [dup, b, dup] },
      { items: [{ ...dup, detail: 'edited' }, b, dup] },
      { items: [dup, b] },
    )
    expect(result.data.items).toEqual([{ ...dup, detail: 'edited' }, b])
    expect(result.conflicts).toEqual([])
  })

  it('row 21: a block the base replaced, keeping none of its data, is not merged into', () => {
    const hero = (heading: string, sub: string, more = {}) => ({
      template: 'hero',
      value: { heading, sub, ...more },
    })
    const result = merge(
      { blocks: [hero('A', 'a')] },
      { blocks: [hero('B', 'b')] },
      { blocks: [hero('A', 'a', { cta: 'x' })] },
    )
    expect(result.data.blocks).toEqual([hero('A', 'a', { cta: 'x' })])
    expect(result.conflicts.map((c) => [c.kind, c.item])).toEqual([['changed', true]])
  })

  it('row 14: a keyless item put where a keyed one was takes none of its key', () => {
    const [x, y] = [
      { title: 'x', detail: 'one' },
      { title: 'y', detail: 'two' },
    ]
    const [hx, hy] = itemKeysAsRead([x, y]) as string[]
    const keyed = {
      items: [
        { ...x, _key: hx },
        { ...y, _key: hy },
      ],
    }
    const replaced = {
      items: [
        { title: 'new', detail: 'three' },
        { ...y, _key: hy },
      ],
    }
    const result = merge(keyed, keyed, replaced)
    expect(result.data).toStrictEqual(replaced)
    expect(result.keyRemaps).toEqual([])
  })

  const listsOnly: FieldConfig[] = [
    { name: 'items', type: 'object', list: true, fields: text('title', 'detail') },
    { name: 'l2', type: 'object', list: true, fields: text('title', 'detail') },
  ]

  it('row 14: an item a hand edit moved from another list is new there, not the item it displaced', () => {
    const [x, y] = [
      { title: 'x', detail: 'one' },
      { title: 'y', detail: 'two' },
    ]
    const result = run(
      { data: { items: [x], l2: [y] } },
      { data: { items: [{ ...x, detail: 'base' }], l2: [y] } },
      { data: { items: [y], l2: [] } },
      'md',
      listsOnly,
    )
    expect(kinds(result).map((c) => c.kind)).toEqual(['removed-by-you'])
  })

  it('row 14: a new item with a key from its own content, in a deleted item place, is new', () => {
    const [x, z] = [
      { title: 'x', detail: 'one' },
      { title: 'z', detail: 'two' },
    ]
    const n = { title: 'n', detail: 'three' }
    const result = run(
      { data: { items: [x, z] } },
      { data: { items: [{ ...x, detail: 'base' }, z] } },
      { data: { items: [{ ...n, _key: itemKeysAsRead([n])[0]! }, z] } },
      'md',
      listsOnly,
    )
    expect(kinds(result).map((c) => c.kind)).toEqual(['removed-by-you'])
  })

  it('row 19: items sharing a value with two ancestor items pair with the earliest, in order', () => {
    const [a, b] = [
      { title: 'p', detail: 'x' },
      { title: 'q', detail: 'x' },
    ]
    const ha = itemKeysAsRead([a, b])[0]!
    const result = run(
      { data: { items: [a, b] } },
      {
        data: {
          items: [
            { ...a, title: 'p2' },
            { ...b, title: 'q2' },
          ],
        },
      },
      {
        data: {
          items: [
            { ...a, detail: 'x-B', _key: ha },
            { ...b, _key: itemKeysAsRead([a, b])[1]! },
          ],
        },
      },
      'md',
      listsOnly,
    )
    expect(
      (result.data.items as Array<{ title: string; detail: string }>).map((i) => [
        i.title,
        i.detail,
      ]),
    ).toEqual([
      ['p2', 'x-B'],
      ['q2', 'x'],
    ])
  })

  it('row 14: an item a hand edit moved without its key, which the other side deleted, conflicts', () => {
    const i1 = { title: 'one', detail: 'd', _key: 'Ki1aaaaaaaaa' }
    const result = run(
      { data: { items: [i1], l2: [] } },
      { data: { items: [], l2: [{ title: 'one', detail: 'd' }] } },
      { data: { items: [], l2: [] } },
      'md',
      listsOnly,
    )
    expect(kinds(result).map((c) => c.kind)).toEqual(['removed-by-you'])
  })

  it('row 21: a keyless block edited on both sides in different fields merges by field', () => {
    const hero = (heading: string, sub: string) => ({ template: 'hero', value: { heading, sub } })
    const result = merge(
      { blocks: [hero('H', 'S')] },
      { blocks: [hero('H', 'S2')] },
      { blocks: [hero('H2', 'S')] },
    )
    expect(result.data.blocks).toEqual([hero('H2', 'S2')])
    expect(result.conflicts).toEqual([])
  })

  it('row 14: an item one side deleted beside one the other side edited keeps that conflict', () => {
    const [x, y] = [
      { title: 'x', detail: 'one' },
      { title: 'y', detail: 'two' },
    ]
    const result = merge({ items: [x, y] }, { items: [x] }, { items: [{ ...y, title: 'y2' }] })
    expect(kinds(result).map((c) => c.kind)).toEqual(['removed-on-base'])
  })
})

describe('shapes the fix review found', () => {
  const lists: FieldConfig[] = [
    { name: 'items', type: 'object', list: true, fields: text('title', 'detail') },
    { name: 'l2', type: 'object', list: true, fields: text('title', 'detail') },
    { name: 'l3', type: 'object', list: true, fields: text('title', 'detail') },
  ]

  it('row 14: a large list edited throughout by hand still conflicts with a delete', () => {
    const o = Array.from({ length: 101 }, (_, i) => ({ title: `t${i}`, detail: 'd' }))
    const result = run(
      { data: { items: o } },
      { data: { items: o.map((item) => ({ ...item, detail: 'd2' })) } },
      { data: { items: o.filter((_, i) => i !== 50) } },
      'md',
      lists,
    )
    expect(result.conflicts.map((c) => c.kind)).toEqual(['removed-by-you'])
    expect((result.data.items as unknown[]).length).toBe(100)
  })

  it('row 14: a list too alike to score pairs by place, so a delete still conflicts', () => {
    const o = Array.from({ length: 1500 }, (_, i) => ({ title: `t${i}`, detail: 'd' }))
    const result = run(
      { data: { items: o } },
      { data: { items: o.map((item) => ({ ...item, title: item.title.toUpperCase() })) } },
      { data: { items: o.filter((_, i) => i !== 700) } },
      'md',
      lists,
    )
    expect(result.conflicts.map((c) => c.kind)).toEqual(['removed-by-you'])
  })

  it('row 14: a keyless edit whose new content matches an item of another list is still an edit', () => {
    const result = run(
      { data: { items: [{ title: 'Docs', detail: 'x' }], l2: [{ title: 'Docs', detail: 'y' }] } },
      { data: { items: [{ title: 'Docs', detail: 'y' }], l2: [{ title: 'Docs', detail: 'y' }] } },
      { data: { items: [], l2: [{ title: 'Docs', detail: 'y' }] } },
      'md',
      lists,
    )
    expect(result.conflicts.map((c) => c.kind)).toEqual(['removed-by-you'])
  })

  it('row 14: a keyed item moved away and deleted conflicts though another item reads alike', () => {
    const same = { title: 'Learn more', detail: '/x' }
    const [k1, k2] = [
      { ...same, _key: 'K1aaaaaaaaaa' },
      { ...same, _key: 'K2aaaaaaaaaa' },
    ]
    const result = run(
      { data: { items: [k1], l2: [k2], l3: [] } },
      { data: { items: [], l2: [k2], l3: [k1] } },
      { data: { items: [], l2: [k2], l3: [] } },
      'md',
      lists,
    )
    expect(kinds(result)).toEqual([{ key: `l3.${k1._key}`, kind: 'removed-by-you', item: true }])
  })

  it('row 15: a keyed copy into another list is a new item, whatever happens to the original', () => {
    const x = { title: 'x', detail: 'one', _key: 'Kxaaaaaaaaaa' }
    const copy = { ...x, _key: 'Knewaaaaaaaa' }
    const result = run(
      { data: { items: [x], l2: [] } },
      { data: { items: [], l2: [] } },
      { data: { items: [x], l2: [copy] } },
      'md',
      lists,
    )
    expect(result.data).toEqual({ items: [], l2: [copy] })
    expect(result.conflicts).toEqual([])
  })

  it('row 14: a keyed item moved in from another list never pairs with an item it resembles', () => {
    // `b` carries the key a read gave it from its content, as an editor's first save writes.
    const a = { title: 'a', detail: 'x' }
    const b = { title: 'b', detail: 'x', _key: itemKeysAsRead([{ title: 'b', detail: 'x' }])[0]! }
    const result = run(
      { data: { items: [a], l2: [b] } },
      { data: { items: [{ ...a, title: 'a2' }], l2: [b] } },
      { data: { items: [b], l2: [] } },
      'md',
      lists,
    )
    expect(result.conflicts.map((c) => c.kind)).toEqual(['removed-by-you'])
  })

  it('row 15: the same keyless item added to two lists, one on each side, is no conflict', () => {
    const more = { title: 'More', detail: 'm' }
    const result = run(
      { data: { items: [], l2: [] } },
      { data: { items: [more], l2: [] } },
      { data: { items: [], l2: [more] } },
      'md',
      lists,
    )
    expect(result.data).toEqual({ items: [more], l2: [more] })
    expect(result.conflicts).toEqual([])
  })

  it('row 14: a keyless copy into another list, beside a delete of the original, is no conflict', () => {
    const x = { title: 'x', detail: 'one' }
    const result = run(
      { data: { items: [x], l2: [] } },
      { data: { items: [x], l2: [x] } },
      { data: { items: [], l2: [] } },
      'md',
      lists,
    )
    expect(result.data).toEqual({ items: [], l2: [x] })
    expect(result.conflicts).toEqual([])
  })
})

describe('conflicts inside a value the drawer shows whole are named at that value', () => {
  const cases: Array<[string, Data, Data, Data, string]> = [
    [
      'an image',
      { cover: { src: '/a.png', alt: 'A' } },
      { cover: { src: '/a.png', alt: 'B' } },
      { cover: { src: '/a.png', alt: 'M' } },
      'cover',
    ],
    [
      'a record outside the schema',
      { meta: { a: 1 } },
      { meta: { a: 2 } },
      { meta: { a: 3 } },
      '?meta',
    ],
    [
      'a list outside the schema',
      { legacy: [{ t: 'x', _key: 'k1' }] },
      { legacy: [{ t: 'B', _key: 'k1' }] },
      { legacy: [{ t: 'M', _key: 'k1' }] },
      '?legacy',
    ],
    [
      'a block whose template the schema lacks',
      { blocks: [{ template: 'gone', value: { h: 'H' }, _key: 'b1' }] },
      { blocks: [{ template: 'gone', value: { h: 'B' }, _key: 'b1' }] },
      { blocks: [{ template: 'gone', value: { h: 'M' }, _key: 'b1' }] },
      'blocks.b1',
    ],
  ]
  for (const [name, o, a, b, key] of cases) {
    it(name, () => {
      const result = merge(o, a, b)
      expect(result.conflicts.map((c) => c.key)).toEqual([key])
      const drawer = computeEntryDiff({
        fields,
        before: { format: 'json', entryType: 'page', data: entryAsRead(fields, o) },
        after: { format: 'json', entryType: 'page', data: entryAsRead(fields, b) },
        marks: false,
      })
      expect(drawer.changes.map((c) => [c.key, c.dataPath])).toContainEqual([
        key,
        result.conflicts[0].dataPath,
      ])
    })
  }

  it('a conflict inside an image carries the whole image versions, and covers both members', () => {
    const o = { src: '/a.png', alt: 'old' }
    const a = { src: '/base.png', alt: 'base alt' }
    const b = { src: '/branch.png', alt: 'branch alt' }
    const result = merge({ cover: o }, { cover: a }, { cover: b })
    expect(result.conflicts).toEqual([
      {
        key: 'cover',
        dataPath: [{ field: 'cover' }],
        kind: 'changed',
        ancestor: o,
        base: a,
        branch: b,
      },
    ])
  })

  it('a conflict inside a record outside the schema carries the whole record versions', () => {
    const result = merge(
      { extra: { p: 1, q: 1 } },
      { extra: { p: 2, q: 2 } },
      { extra: { p: 3, q: 3 } },
    )
    expect(result.conflicts).toEqual([
      {
        key: '?extra',
        dataPath: [{ field: 'extra' }],
        kind: 'changed',
        ancestor: { p: 1, q: 1 },
        base: { p: 2, q: 2 },
        branch: { p: 3, q: 3 },
      },
    ])
  })

  it('an item the branch removed is named by the ancestor key, as the drawer names it', () => {
    const t = { title: 'T', detail: 'd' }
    const result = merge({ items: [t] }, { items: [{ ...t, title: 'B' }] }, { items: [] })
    const ancestorKey = itemKeysAsRead([t])[0]
    expect(kinds(result)).toEqual([
      { key: `items.${ancestorKey}`, kind: 'removed-by-you', item: true },
    ])
    const drawer = computeEntryDiff({
      fields,
      before: { format: 'json', entryType: 'page', data: entryAsRead(fields, { items: [t] }) },
      after: { format: 'json', entryType: 'page', data: entryAsRead(fields, { items: [] }) },
      marks: false,
    })
    expect(drawer.changes.map((c) => c.key)).toContain(`items.${ancestorKey}`)
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
