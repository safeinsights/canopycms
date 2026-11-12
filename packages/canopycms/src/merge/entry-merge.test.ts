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
import { itemKeysAsRead, itemKeysOnPath, resolveThreadPath } from '../item-keys'
import { entryAsRead } from '../utils/calendar-day'
import { serializeFrontmatter, serializeYaml } from '../utils/content-serialize'
import { checkSidePaths, valueAtSidePath } from './__test__/side-paths'
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
/** A merge's result, its conflicts' side paths checked against the three versions and set aside. */
type Merged = Omit<Extract<EntryMergeResult, { kind: 'merged' }>, 'conflicts'> & {
  conflicts: Array<Omit<FieldConflict, 'sidePaths'>>
}

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
  return {
    ...result,
    conflicts: checkSidePaths(result.conflicts, { ancestor: o, base: a, branch: b }, schema),
  }
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
      // The item takes the key the base's version reads under; the branch's threads follow it.
      const kBase = itemKeysAsRead([t1, { ...t2, detail: 'two (base)' }])[1]!
      expect(result.data.items).toEqual([
        { ...t1, _key: k1 },
        { title: 'Two (mine)', detail: 'two (base)', _key: kBase },
      ])
      expect(result.conflicts).toEqual([])
      expect(result.keyRemaps).toEqual([{ within: [], from: k2, to: kBase }])
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
      const kBase = itemKeysAsRead([t1, { ...t2, title: 'Two (base)' }])[1]!
      expect(result.data.items).toEqual([
        { ...t1, _key: k1 },
        { ...t2, title: 'Two (mine)', _key: kBase },
      ])
      expect(kinds(result)).toEqual([{ key: `items.${kBase}.title`, kind: 'changed' }])
    })

    it('row 12: with a bare date and no schema, a key names an item the branch rewrote whole', () => {
      // Only the key ties the rewritten item to its ancestor: it keeps none of the values.
      const day = { title: 'Launch', on: new Date('2026-03-01T00:00:00.000Z') }
      const asRead = itemKeysAsRead([{ title: 'Launch', on: '2026-03-01' }])[0]!
      const rewritten = { title: 'Release', on: new Date('2026-04-01T00:00:00.000Z'), _key: asRead }
      const result = run(
        { data: { items: [day] } },
        { data: { items: [{ ...day, note: 'base' }] } },
        { data: { items: [rewritten] } },
        'md',
        undefined,
      )
      const kBase = itemKeysAsRead([{ ...day, note: 'base' }])[0]
      expect(result.data.items).toEqual([{ ...rewritten, note: 'base', _key: kBase }])
      expect(result.conflicts).toEqual([])
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
      const kBase = itemKeysAsRead([{ ...day, note: 'base' }])[0]
      expect(result.data.items).toEqual([
        { ...day, title: 'Launch day', note: 'base', _key: kBase },
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
      { ...q, detail: 'q (base)', _key: itemKeysAsRead([p, p, { ...q, detail: 'q (base)' }])[2] },
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
      {
        key: `items.${itemKeysAsRead([x, { t: 'y (base)' }, z])[1]}`,
        kind: 'removed-by-you',
        item: true,
      },
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
      {
        key: `items.${itemKeysAsRead([x, { t: 'y (base)' }])[1]}`,
        kind: 'removed-by-you',
        item: true,
      },
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
      {
        key: `items.${itemKeysAsRead([x, { ...y, title: 'y (base)' }])[1]}`,
        kind: 'removed-by-you',
        item: true,
      },
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
    const replacement = { title: 'replacement', detail: '2' }
    expect(result.data.items).toEqual([
      { title: 'replacement', detail: 'mine', _key: itemKeysAsRead([replacement])[0] },
    ])
    expect(result.conflicts).toEqual([])
    expect(hq).not.toBe(itemKeysAsRead([replacement])[0])
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

describe('a branch over several syncs', () => {
  const schema: FieldConfig[] = [
    ...text('title'),
    { name: 'items', type: 'object', list: true, fields: text('heading', 'text') },
  ]
  type It = { heading: string; text: string; _key?: string }
  const sync = (o: Data, a: Data, b: Data) =>
    run({ data: o }, { data: a }, { data: b }, 'json', schema)
  const ancestor = {
    title: 't',
    items: [
      { heading: 'One', text: 'first item text' },
      { heading: 'Two', text: 'second item text' },
      { heading: 'Three', text: 'third item text' },
    ],
  }
  const withItems = (items: It[]) => ({ ...ancestor, items })
  const reworded = ancestor.items.map((item, i) =>
    i === 1 ? { ...item, text: 'second item text, reworded' } : item,
  )
  // The editor's first save keyed every item as read and changed only the title; a first sync
  // brings in the base's rewording of Two, under the key Two's old content gave it.
  const first = sync(ancestor, withItems(reworded), {
    ...entryAsRead(schema, structuredClone(ancestor)),
    title: 'mine',
  })
  const branch = first.data
  const headings = (result: Merged) =>
    (result.data.items as It[]).map((item) => [item.heading, item.text])

  it('row 18: an item the base deletes after a sync brought in its edit is deleted', () => {
    const result = sync(withItems(reworded), withItems([reworded[0], reworded[2]]), branch)
    expect(headings(result)).toEqual([
      ['One', 'first item text'],
      ['Three', 'third item text'],
    ])
    expect(result.conflicts).toEqual([])
  })

  it('row 18: an item the base edits again after a sync is edited, not doubled', () => {
    const again = reworded.map((item, i) => (i === 1 ? { ...item, text: 'reworded twice' } : item))
    const result = sync(withItems(reworded), withItems(again), branch)
    expect(headings(result)).toEqual(again.map((item) => [item.heading, item.text]))
    expect(result.conflicts).toEqual([])
    // The key the base's latest version reads under, which the next sync's ancestor knows.
    expect((result.data.items as It[])[1]._key).toBe(itemKeysAsRead(again)[1])
  })

  it('row 16: a reorder by the base after a sync takes the base order', () => {
    const result = sync(withItems(reworded), withItems([...reworded].reverse()), branch)
    expect(headings(result)).toEqual(
      [...reworded].reverse().map((item) => [item.heading, item.text]),
    )
    expect(result.conflicts).toEqual([])
  })

  it('row 18: an item the branch edited, then the base edits in another field, merges', () => {
    const mine = (branch.items as It[]).map((item, i) =>
      i === 1 ? { ...item, heading: 'Two (mine)' } : item,
    )
    const again = reworded.map((item, i) => (i === 1 ? { ...item, text: 'reworded twice' } : item))
    const result = sync(withItems(reworded), withItems(again), { ...branch, items: mine })
    expect(headings(result)[1]).toEqual(['Two (mine)', 'reworded twice'])
    expect(result.conflicts).toEqual([])
  })

  it('row 14: an item under a key the base dropped by hand is still the item it names', () => {
    const minted = { heading: 'Four', text: 'fourth', _key: 'Mfour1234567' }
    const base = withItems([...reworded, { heading: 'Four', text: 'fourth' }])
    const mine = { ...branch, items: [...(branch.items as It[]), minted] }
    const result = sync(base, withItems(reworded), mine)
    expect(headings(result)).toEqual(reworded.map((item) => [item.heading, item.text]))
    expect(result.conflicts).toEqual([])
  })

  it('row 14: a new item with a minted key is not an edit of one the branch deleted', () => {
    const replaced = (branch.items as It[]).map((item, i) =>
      i === 1 ? { heading: 'New', text: 'second item text, reworded', _key: 'Mnew12345678' } : item,
    )
    const again = reworded.map((item, i) => (i === 1 ? { ...item, heading: 'Two!' } : item))
    const result = sync(withItems(reworded), withItems(again), { ...branch, items: replaced })
    expect(result.conflicts.map((c) => c.kind)).toEqual(['removed-by-you'])
  })

  it('row 14: a new item reading like a deleted one with a minted key is not that item', () => {
    const k1 = { heading: 'a', text: '1', _key: 'K1aaaaaaaaaa' }
    const lookalike = { heading: 'a', text: '1', _key: 'Mxaaaaaaaaaa' }
    const result = sync(withItems([k1]), withItems([{ ...k1, text: '2' }]), withItems([lookalike]))
    expect(result.conflicts.map((c) => c.kind)).toEqual(['removed-by-you'])
  })

  it('remaps the branch key of an item the base replaced in its place, so threads follow', () => {
    const link = (href: string) => ({ heading: href, text: '' })
    const o = withItems([link('/a'), link('/b')])
    const keyed = entryAsRead(schema, structuredClone(o)) as { items: It[] }
    const result = sync(o, withItems([link('/a'), link('/b2')]), { ...o, items: keyed.items })
    expect(headings(result)).toEqual([
      ['/a', ''],
      ['/b2', ''],
    ])
    expect(result.keyRemaps).toEqual([
      {
        within: [],
        from: keyed.items[1]._key,
        to: itemKeysAsRead([link('/b2')])[0],
      },
    ])
  })
})

describe("twins a git-level merge left under each other's first-save keys", () => {
  const page: FieldConfig[] = [
    ...text('title'),
    { name: 'items', type: 'object', list: true, fields: text('heading', 'text', 'link') },
  ]
  const card = { heading: 'Card', text: 'same', link: '/a' }
  const other = { heading: 'Other', text: 'o', link: '/o' }
  // The branch's first save keyed the twins X and X-2; the base reworded the first by hand, and
  // a git-level merge brought that in beside the keys, so X now sits on the reworded card.
  const o = { title: 't', items: [card, { ...card, text: 'reworded' }, other] }
  const ancestor = { title: 't', items: [{ ...card, text: 'reworded' }, card, other] }
  const firstSave = entryAsRead(page, structuredClone({ ...o, items: [card, card, other] })) as {
    items: Data[]
  }
  const branch = {
    title: 'my title',
    items: [{ ...firstSave.items[0], text: 'reworded' }, firstSave.items[1], firstSave.items[2]],
  }
  const merge = (base: Data, schema: FieldConfig[] | undefined) => {
    const result = mergeEntry({
      format: 'json',
      ancestor: { data: structuredClone(ancestor) },
      base: { data: structuredClone(base) },
      branch: { data: structuredClone(branch) },
      ...(schema && { fields: schema }),
    })
    if (result.kind !== 'merged') throw new Error('expected a merge')
    const items = (result.data.items as Data[]).map(({ text }) => text)
    return { items, conflicts: result.conflicts, title: result.data.title }
  }
  const withItems = (items: Data[]) => ({ ...ancestor, items })
  const [reworded, twin] = ancestor.items

  for (const schema of [page, undefined]) {
    describe(schema ? 'with a schema' : 'with no schema', () => {
      it('A: the base deletes the reworded card: it stays deleted', () => {
        const result = merge(withItems([twin, other]), schema)
        expect(result).toMatchObject({ items: ['same', 'o'], conflicts: [], title: 'my title' })
      })

      it('B: the base rewords it again: the reword stands', () => {
        const result = merge(withItems([{ ...reworded, text: 'twice' }, twin, other]), schema)
        expect(result).toMatchObject({ items: ['twice', 'same', 'o'], conflicts: [] })
      })

      it('C: the base edits the other twin: the edit stands, on that twin', () => {
        const result = merge(withItems([reworded, { ...twin, text: 'base' }, other]), schema)
        expect(result).toMatchObject({ items: ['reworded', 'base', 'o'], conflicts: [] })
      })

      it('E: the base deletes the other twin: it stays deleted', () => {
        const result = merge(withItems([reworded, other]), schema)
        expect(result).toMatchObject({ items: ['reworded', 'o'], conflicts: [] })
      })
    })
  }

  it('trusts the key of an original the branch edited beside a copy it minted', () => {
    const list: FieldConfig[] = [
      { name: 'items', type: 'object', list: true, fields: text('heading', 'text', 'link') },
    ]
    const [X] = itemKeysAsRead([card]) as string[]
    const result = mergeEntry({
      format: 'json',
      ancestor: { data: { items: [card] } },
      base: { data: { items: [{ ...card, link: '/b' }] } },
      branch: {
        data: {
          items: [
            { ...card, text: 'mine', _key: X },
            { ...card, _key: '1aaaaaaaaaaa' },
          ],
        },
      },
      fields: list,
    })
    if (result.kind !== 'merged') throw new Error('expected a merge')
    expect(result.conflicts).toEqual([])
    expect((result.data.items as Data[]).map(({ text, link }) => [text, link])).toEqual([
      ['mine', '/b'],
      ['same', '/a'],
    ])
  })

  it('trusts a key the ancestor item carries as its own, beside a twin under the next one', () => {
    const list: FieldConfig[] = [
      { name: 'items', type: 'object', list: true, fields: text('heading', 'text', 'link') },
    ]
    const [X, X2] = itemKeysAsRead([card, card]) as string[]
    const result = mergeEntry({
      format: 'json',
      ancestor: { data: { items: [{ ...card, _key: X }] } },
      base: { data: { items: [{ ...card, link: '/b', _key: X }] } },
      branch: {
        data: {
          items: [
            { ...card, text: 'mine', _key: X },
            { ...card, _key: X2 },
          ],
        },
      },
      fields: list,
    })
    if (result.kind !== 'merged') throw new Error('expected a merge')
    expect(result.conflicts).toEqual([])
    expect((result.data.items as Data[]).map(({ text, link }) => [text, link])).toEqual([
      ['mine', '/b'],
      ['same', '/a'],
    ])
  })

  it('reads a holder of a key another list now reads under as the item of its own list it holds', () => {
    // A twin across lists: the base deletes the reworded card, which holds the other list's key.
    const lists: FieldConfig[] = [
      { name: 'items', type: 'object', list: true, fields: text('heading', 'text', 'link') },
      { name: 'l2', type: 'object', list: true, fields: text('heading', 'text', 'link') },
    ]
    const [X] = itemKeysAsRead([card]) as string[]
    const reworded = { ...card, text: 'reworded' }
    const result = mergeEntry({
      format: 'json',
      ancestor: { data: { items: [reworded, other], l2: [card] } },
      base: { data: { items: [other], l2: [card] } },
      branch: {
        data: {
          items: [
            { ...reworded, _key: X },
            { ...other, _key: itemKeysAsRead([other])[0] },
          ],
          l2: [{ ...card, _key: 'h' + 'Zz9'.repeat(3) }],
        },
      },
      fields: lists,
    })
    if (result.kind !== 'merged') throw new Error('expected a merge')
    expect(result.conflicts).toEqual([])
    expect((result.data.items as Data[]).map(({ text }) => text)).toEqual(['o'])
  })

  it('trusts a minted key on an item the branch made read like one it deleted', () => {
    const list: FieldConfig[] = [
      { name: 'items', type: 'object', list: true, fields: text('h', 't', 'u') },
    ]
    const [m, k] = [
      { h: 'm', t: '1', u: 'x' },
      { h: 'k', t: '1', u: 'y' },
    ]
    const M = '1aaaaaaaaaaa'
    const result = mergeEntry({
      format: 'json',
      ancestor: { data: { items: [{ ...m, _key: M }, k] } },
      base: { data: { items: [{ ...m, t: '2', _key: M }, k] } },
      branch: { data: { items: [{ ...k, _key: M }] } },
      fields: list,
    })
    if (result.kind !== 'merged') throw new Error('expected a merge')
    expect(result.conflicts).toEqual([])
    expect(result.data.items).toEqual([{ h: 'k', t: '2', u: 'y', _key: M }])
  })

  it('trusts the key of an item the branch made read like one it kept under its own key', () => {
    const list: FieldConfig[] = [
      { name: 'items', type: 'object', list: true, fields: text('h', 't') },
    ]
    const [p, q] = [
      { h: 'p', t: '1' },
      { h: 'q', t: '1' },
    ]
    const [P, Q] = itemKeysAsRead([p, q]) as string[]
    const result = mergeEntry({
      format: 'json',
      ancestor: { data: { items: [p, q] } },
      base: { data: { items: [{ ...p, t: '2' }, q] } },
      branch: {
        data: {
          items: [
            { ...q, _key: P },
            { ...q, _key: Q },
          ],
        },
      },
      fields: list,
    })
    if (result.kind !== 'merged') throw new Error('expected a merge')
    expect(result.conflicts).toEqual([])
    expect((result.data.items as Data[]).map(({ h, t }) => [h, t])).toEqual([
      ['q', '2'],
      ['q', '1'],
    ])
  })

  describe('editor twins, keyed as read, with no git-level merge', () => {
    const list: FieldConfig[] = [
      { name: 'items', type: 'object', list: true, fields: text('heading', 'text', 'link') },
    ]
    const [K, K2, K3] = itemKeysAsRead([card, card, card]) as string[]
    const J = itemKeysAsRead([other])[0] as string
    const run3 = (o: Data[], a: Data[], b: Data[]) => {
      const result = mergeEntry({
        format: 'json',
        ancestor: { data: { items: o } },
        base: { data: { items: a } },
        branch: { data: { items: b } },
        fields: list,
      })
      if (result.kind !== 'merged') throw new Error('expected a merge')
      return result
    }
    const twins = [
      { ...card, _key: K },
      { ...card, _key: K2 },
      { ...other, _key: J },
    ]

    it('the base deletes one twin and the branch edits the other: both stand, no remap', () => {
      const result = run3(
        twins,
        [twins[1], twins[2]],
        [twins[0], { ...twins[1], text: 'mine' }, twins[2]],
      )
      expect(result.conflicts).toEqual([])
      expect((result.data.items as Data[]).map((i) => [i.text, i._key])).toEqual([
        ['mine', K2],
        ['o', J],
      ])
      expect(result.keyRemaps).toEqual([])
    })

    it('the branch deletes one twin and the base edits the other: both stand', () => {
      const result = run3(
        twins,
        [twins[0], { ...twins[1], text: 'base' }, twins[2]],
        [twins[1], twins[2]],
      )
      expect(result.conflicts).toEqual([])
      expect((result.data.items as Data[]).map((i) => i.text)).toEqual(['base', 'o'])
    })

    it('the branch deletes the twin the base edits, among three: a conflict on it', () => {
      const three = [twins[0], twins[1], { ...card, _key: K3 }]
      const result = run3(
        three,
        [three[0], { ...three[1], text: 'base' }, three[2]],
        [three[0], three[2]],
      )
      expect(result.conflicts.map((c) => c.kind)).toEqual(['removed-by-you'])
      expect((result.data.items as Data[]).map((i) => i._key)).toEqual([K, K3])
    })
  })

  describe('a twin under its own read key, which repeats a key the ancestor no longer reads', () => {
    const list: FieldConfig[] = [
      { name: 'items', type: 'object', list: true, fields: text('h', 't') },
      { name: 'l2', type: 'object', list: true, fields: text('h', 't') },
    ]
    const [T, Y] = [
      { h: 'T', t: 't' },
      { h: 'Y', t: 'y' },
    ]
    const [K, K2, K3] = itemKeysAsRead([T, T, T]) as string[]
    const KY = itemKeysAsRead([Y])[0] as string
    const twice = (o: Data, a: Data, b: Data) => {
      const result = mergeEntry({
        format: 'json',
        ancestor: { data: o },
        base: { data: a },
        branch: { data: b },
        fields: list,
      })
      if (result.kind !== 'merged') throw new Error('expected a merge')
      return {
        items: (result.data.items as Data[]).map((i) => i.t),
        conflicts: result.conflicts.map((c) => c.kind),
      }
    }
    // The branch deleted the first T and holds the last under K-3, its own read key once.
    const branch = {
      items: [
        { ...Y, _key: KY },
        { ...T, _key: K3 },
      ],
    }

    it('the base deletes the last: both deletions stand', () => {
      expect(twice({ items: [T, Y, T] }, { items: [T, Y] }, branch)).toEqual({
        items: ['y'],
        conflicts: [],
      })
    })

    it('the base edits the first: a conflict on it, which the branch deleted', () => {
      const result = twice({ items: [T, Y, T] }, { items: [{ ...T, t: 'base' }, Y, T] }, branch)
      expect(result.conflicts).toEqual(['removed-by-you'])
    })

    it('another list reads the key: still a conflict on the first', () => {
      const l2 = [T, T, T]
      const result = twice(
        { items: [T, Y, T], l2 },
        { items: [{ ...T, t: 'base' }, Y, T], l2 },
        { ...branch, l2: [K, K2, K3].map((_key) => ({ ...T, _key })) },
      )
      expect(result.conflicts).toEqual(['removed-by-you'])
    })

    it('on the base side, against a branch edit of the first: a conflict on it', () => {
      const result = twice({ items: [T, Y, T] }, branch, {
        items: [
          { ...T, t: 'mine', _key: K },
          { ...Y, _key: KY },
          { ...T, _key: K2 },
        ],
      })
      expect(result.conflicts).toEqual(['removed-on-base'])
    })
  })

  it('names a dated twin by the key a read of its day gives, with no schema', () => {
    const day = new Date('2024-01-01T00:00:00.000Z')
    const A = { h: 'A', t: 'a', d: day }
    const [, T2] = itemKeysAsRead([
      { ...A, d: '2024-01-01' },
      { ...A, d: '2024-01-01' },
    ]) as string[]
    const result = mergeEntry({
      format: 'md',
      ancestor: { data: { items: [A, A] }, body: '' },
      base: { data: { items: [A, { ...A, t: 'base' }] }, body: '' },
      branch: { data: { items: [{ ...A, _key: T2 }] }, body: '' },
    })
    if (result.kind !== 'merged') throw new Error('expected a merge')
    expect(result.conflicts).toEqual([])
    expect((result.data.items as Data[]).map((i) => i.t)).toEqual(['base'])
  })

  it('D: the base edits the other twin and the branch edits a third item: both stand', () => {
    const edited = {
      ...branch,
      items: [branch.items[0], branch.items[1], { ...branch.items[2], text: 'mine' }],
    }
    const result = mergeEntry({
      format: 'json',
      ancestor: { data: structuredClone(ancestor) },
      base: { data: withItems([reworded, { ...twin, text: 'base' }, other]) },
      branch: { data: edited },
      fields: page,
    })
    if (result.kind !== 'merged') throw new Error('expected a merge')
    expect(result.conflicts).toEqual([])
    expect((result.data.items as Data[]).map(({ text }) => text)).toEqual([
      'reworded',
      'base',
      'mine',
    ])
  })
})

describe('stale keys a git rebase leaves', () => {
  // A rebase takes the base's edit into the branch's item under the key its old content read
  // under: three-field items, so a match can hold most of an item's values.
  const schema3: FieldConfig[] = [
    { name: 'items', type: 'object', list: true, fields: text('h', 't', 'k') },
    { name: 'l2', type: 'object', list: true, fields: text('h', 't', 'k') },
  ]
  const stale = (item: Data, from: Data) => ({ ...item, _key: itemKeysAsRead([from])[0] })
  const sync = (o: Data, a: Data, b: Data) =>
    run({ data: o }, { data: a }, { data: b }, 'json', schema3)

  it('row 18: a stale item matches the one item holding most of its values', () => {
    const [x, y] = [
      { h: 'x', t: '1', k: 'k' },
      { h: 'y', t: '2', k: 'k' },
    ]
    const mine = stale({ ...y, h: 'y (mine)' }, { h: 'y0', t: '0', k: 'k' })
    const result = sync({ items: [x, y] }, { items: [x, { ...y, t: '2b' }] }, { items: [mine] })
    expect(result.data.items).toEqual([
      { ...mine, t: '2b', _key: itemKeysAsRead([x, { ...y, t: '2b' }])[1] },
    ])
    expect(result.conflicts).toEqual([])
  })

  it('row 18: a stale item two items match alike makes the list one conflicting value', () => {
    const [x, y] = [
      { h: 'x', t: '1', k: 'k' },
      { h: 'y', t: '1', k: 'k' },
    ]
    const mine = stale({ h: 'z', t: '1', k: 'k' }, { h: 'z0', t: '0', k: 'k' })
    const result = sync({ items: [x, y] }, { items: [{ ...x, h: 'x2' }, y] }, { items: [mine] })
    expect(kinds(result)).toEqual([{ key: 'items', kind: 'changed' }])
    expect(result.data.items).toEqual([mine])
  })

  it('row 18: a stale two-field item no clear match finds conflicts, never reads as new', () => {
    const two: FieldConfig[] = [
      { name: 'items', type: 'object', list: true, fields: text('q', 'a') },
    ]
    const q0 = { q: 'q0-A', a: 'a0' }
    const mine = { q: 'q0-A', a: 'a0-B', _key: itemKeysAsRead([{ q: 'q0', a: 'a0' }])[0] }
    const result = run(
      { data: { items: [q0, { q: 'q1', a: 'a1' }] } },
      { data: { items: [{ q: 'q1', a: 'a1' }] } },
      { data: { items: [mine] } },
      'json',
      two,
    )
    expect(result.conflicts).not.toEqual([])
  })

  it('row 18: a stale item keeping under half of the values pairs only by place', () => {
    const x = { h: 'x', t: '1', k: 'k' }
    const mine = stale({ h: 'z', t: '2', k: 'k' }, { h: 'z0', t: '0', k: 'k' })
    const result = sync({ items: [x] }, { items: [{ ...x, h: 'x2' }] }, { items: [mine] })
    expect(result.conflicts.map((c) => [c.kind, c.item])).toEqual([['changed', true]])
  })

  it('row 14: a stale item holding exactly an item of another list moved here: new to this list', () => {
    const [x, y] = [
      { h: 'x', t: '1', k: 'k' },
      { h: 'y', t: '1', k: 'k' },
    ]
    const moved = stale(y, { h: 'y0', t: '0', k: 'k' })
    const result = sync(
      { items: [x], l2: [y] },
      { items: [{ ...x, h: 'x2' }], l2: [y] },
      { items: [moved], l2: [] },
    )
    expect(result.conflicts.map((c) => c.kind)).toContain('removed-by-you')
    expect((result.data.items as Data[]).map((i) => i.h)).toEqual(['y'])
  })
})

describe('keys as a read gives them', () => {
  const dated: FieldConfig[] = [
    {
      name: 'items',
      type: 'object',
      list: true,
      fields: [...text('heading'), { name: 'on', type: 'date' }],
    },
  ]
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
  const keyAsRead = (items: Data[]) =>
    (entryAsRead(dated, { items }) as { items: Data[] }).items.map((item) => item._key)

  it('names a remap to an item the base replaced in place by its key as read, dates as days', () => {
    const o = [
      { heading: '/a', on: day('2026-03-01') },
      { heading: '/b', on: day('2026-03-01') },
    ]
    const branch = keyAsRead(o).map((key, i) => ({ ...o[i], _key: key }))
    const base = [o[0], { heading: '/b2', on: day('2026-04-02') }]
    const result = run(
      { data: { items: o } },
      { data: { items: base } },
      { data: { items: branch } },
      'md',
      dated,
    )
    expect(result.keyRemaps).toEqual([{ within: [], from: branch[1]._key, to: keyAsRead(base)[1] }])
  })

  it('keys an item the base changed by its version as read, dates as days, which the next sync knows', () => {
    const o = [{ heading: 'One', on: day('2026-03-01') }]
    const branch = keyAsRead(o).map((key, i) => ({ ...o[i], _key: key }))
    const base = [{ heading: 'One (base)', on: day('2026-03-01') }]
    const result = run(
      { data: { items: o } },
      { data: { items: base } },
      { data: { items: branch } },
      'md',
      dated,
    )
    expect((result.data.items as Data[])[0]._key).toBe(keyAsRead(base)[0])
    expect(result.keyRemaps).toEqual([{ within: [], from: branch[0]._key, to: keyAsRead(base)[0] }])
  })

  it('remaps a thread on an item no version keyed, to the key its merged content reads under', () => {
    const page: FieldConfig[] = [
      ...text('title'),
      { name: 'items', type: 'object', list: true, fields: text('title', 'body') },
    ]
    const o = {
      title: 'P',
      items: [
        { title: 'T', body: 'B' },
        { title: 'Q', body: 'R' },
      ],
    }
    const base = { ...o, items: [{ title: 'T2', body: 'B' }, o.items[1]] }
    const result = run({ data: o }, { data: base }, { data: { ...o, title: 'P2' } }, 'json', page)
    const thread = itemKeysOnPath(page, entryAsRead(page, o), 'items[0].title')
    expect(result.keyRemaps).toEqual([
      { within: [], from: thread?.[0], to: itemKeysAsRead([base.items[0]])[0] },
    ])
    const merged = entryAsRead(page, result.data)
    const moved = result.keyRemaps.find((r) => r.from === thread?.[0])?.to
    expect(resolveThreadPath(page, merged, 'items[0].title', [moved as string])).toBe(
      'items[0].title',
    )
  })

  it('never re-keys an item onto a key another item of the list holds', () => {
    const page: FieldConfig[] = [
      { name: 'items', type: 'object', list: true, fields: text('t', 'd') },
    ]
    const [x, y] = [
      { t: 'x', d: 'd' },
      { t: 'y', d: 'd' },
    ]
    const [hX, hY] = itemKeysAsRead([x, y]) as string[]
    // A rebase left the branch's y1 under Y's key; the base then made x read like y.
    const branch = {
      items: [
        { ...x, _key: hX },
        { t: 'y1', d: 'd', _key: hY },
      ],
    }
    const result = run(
      { data: { items: [x, { t: 'y1', d: 'd' }] } },
      { data: { items: [y, { t: 'y1', d: 'd' }] } },
      { data: branch },
      'json',
      page,
    )
    const keys = (result.data.items as Data[]).map((i) => i._key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('never remaps a key the branch holds alike in two lists, which a thread could not tell apart', () => {
    const page: FieldConfig[] = [
      { name: 'items', type: 'object', list: true, fields: text('t', 'd') },
      { name: 'l2', type: 'object', list: true, fields: text('t', 'd') },
    ]
    const x = { t: 'x', d: 'd' }
    const hX = itemKeysAsRead([x])[0]
    const result = run(
      { data: { items: [x], l2: [x] } },
      { data: { items: [{ ...x, d: 'd2' }], l2: [x] } },
      { data: { items: [{ ...x, _key: hX }], l2: [{ ...x, _key: hX }] } },
      'json',
      page,
    )
    expect(result.keyRemaps).toEqual([])
    expect((result.data.items as Data[])[0]).toEqual({ ...x, d: 'd2', _key: hX })
  })

  it("never remaps an ambiguous key, which would move the twin list's thread too", () => {
    const page: FieldConfig[] = [
      ...text('title'),
      { name: 'items', type: 'object', list: true, fields: text('t', 'd') },
      { name: 'l2', type: 'object', list: true, fields: text('t', 'd') },
    ]
    const x = { t: 'x', d: 'd' }
    const hX = itemKeysAsRead([x])[0]
    const edited = { ...x, d: 'd2' }
    const hEdited = itemKeysAsRead([edited])[0]
    const keyedBoth = { title: 'T', items: [{ ...x, _key: hX }], l2: [{ ...x, _key: hX }] }
    // The base backfilled its own keys: the edited item's key replaces the branch's.
    const backfilled = run(
      { data: { title: 'T', items: [x], l2: [x] } },
      { data: { title: 'T', items: [{ ...edited, _key: hEdited }], l2: [{ ...x, _key: hX }] } },
      { data: keyedBoth },
      'json',
      page,
    )
    expect(backfilled.keyRemaps).toEqual([])
    // The base replaced the item in place with one sharing no value.
    const inPlace = run(
      { data: { title: 'T', items: [x], l2: [x] } },
      { data: { title: 'T', items: [{ t: 'z', d: 'z' }], l2: [x] } },
      { data: keyedBoth },
      'json',
      page,
    )
    expect(inPlace.keyRemaps).toEqual([])
    // No version keyed anything, and the twin list also holds the edited item: a remap to its
    // key would move the twin's thread onto that other item.
    const twin = { title: 'T', items: [x], l2: [x, edited] }
    const keyless = run(
      { data: twin },
      { data: { ...twin, items: [edited] } },
      { data: { ...twin, title: 'T2' } },
      'json',
      page,
    )
    expect(keyless.keyRemaps).toEqual([])
    const merged = entryAsRead(page, keyless.data)
    expect(resolveThreadPath(page, merged, 'l2[0].d', [hX as string])).toBe('l2[0].d')
  })

  it('keeps the keys and remaps of a list only the base changed, beside an item under a stale key', () => {
    const page: FieldConfig[] = [
      { name: 'items', type: 'object', list: true, fields: text('h', 't', 'k') },
    ]
    const [p, q, r] = ['p', 'q', 'r'].map((h) => ({ h, t: '1', k: 'k' }))
    const [, , hR] = itemKeysAsRead([p, q, r]) as string[]
    // A rebase left the base's new item under a key no content hashes to.
    const staleKey = itemKeysAsRead([{ h: 'gone', t: '0', k: '0' }])[0] as string
    const base = [
      { h: 'p-new', t: '7', k: 'zz', _key: staleKey },
      { ...r, t: '3b' },
    ]
    const keys = itemKeysAsRead([p, q, r])
    const branch = { items: [p, q, r].map((item, i) => ({ ...item, _key: keys[i] })) }
    const result = run(
      { data: { items: [p, q, r] } },
      { data: { items: base } },
      { data: branch },
      'json',
      page,
    )
    expect(result.conflicts).toEqual([])
    expect((result.data.items as Data[]).map(({ _key, ...rest }) => rest)).toEqual(
      base.map(({ _key, ...rest }) => rest),
    )
    const moved = result.keyRemaps.find((m) => m.from === hR)?.to
    const merged = entryAsRead(page, result.data)
    expect(resolveThreadPath(page, merged, 'items[2].t', [moved as string])).toBe('items[1].t')
  })

  it('takes the changed list beside one left alone under other keys, and remaps those keys', () => {
    const page: FieldConfig[] = [
      { name: 'items', type: 'object', list: true, fields: text('h', 't', 'k') },
    ]
    // A content-shaped key no item here hashes to, as a rebase leaves.
    const st = (s: string) => itemKeysAsRead([{ h: s, t: '0', k: '0' }])[0] as string
    const r = { h: 'r', t: '2', k: 'k' }
    const u = { h: 'u', t: '1', k: 'm' }
    const o = [
      { ...r, _key: itemKeysAsRead([r])[0] },
      { ...u, _key: st('main') },
    ]
    // The base deletes r, edits u and adds q under a stale key; the branch holds the same
    // content under stale keys of its own, so its u matches no ancestor item.
    const base = [
      { ...u, t: '1x', _key: st('main') },
      { h: 'q', t: '2', k: 'm', _key: st('q') },
    ]
    const branch = [
      { ...r, _key: st('m1') },
      { ...u, _key: st('m2') },
    ]
    const result = run(
      { data: { items: o } },
      { data: { items: base } },
      { data: { items: branch } },
      'json',
      page,
    )
    expect(result.conflicts).toEqual([])
    expect(result.data.items).toEqual(base)
    // The branch's u reads under the base's key now: its threads follow.
    expect(result.keyRemaps).toEqual([{ within: [], from: st('m2'), to: st('main') }])
    // The other way round: the branch's changed list is the merge, under the base's keys.
    const mirror = run(
      { data: { items: o } },
      { data: { items: branch } },
      { data: { items: base } },
      'json',
      page,
    )
    expect(mirror.conflicts).toEqual([])
    const content = (items: unknown) => (items as Data[]).map(({ _key, ...rest }) => rest)
    expect(content(mirror.data.items)).toEqual(content(base))
  })

  it('never matches alike items a side reordered by place, against the keys it holds', () => {
    const page: FieldConfig[] = [
      { name: 'items', type: 'object', list: true, fields: text('h', 't', 'k') },
    ]
    const st = (s: string) => itemKeysAsRead([{ h: s, t: '0', k: '0' }])[0] as string
    const [M1, M2] = ['1aaaaaaaaaaa', '2aaaaaaaaaaa']
    const x = { h: 'x', t: '1', k: '1' }
    const [y, z] = [
      { h: 'y', t: '2', k: '2' },
      { h: 'z', t: '3', k: '3' },
    ]
    const o = [
      { ...x, _key: M1 },
      { ...x, _key: M2 },
      { ...y, _key: itemKeysAsRead([y])[0] },
      { ...z, _key: itemKeysAsRead([z])[0] },
    ]
    // The base edits M1, rewrites y under a stale key and deletes z; the branch swaps M1 and M2.
    const base = [
      { ...x, t: 'EDIT', _key: M1 },
      { ...x, _key: M2 },
      { h: 'y', t: '9', k: '9', _key: st('s') },
    ]
    const branch = [o[1], o[0], o[2], o[3]]
    const result = run(
      { data: { items: o } },
      { data: { items: base } },
      { data: { items: branch } },
      'json',
      page,
    )
    expect(result.keyRemaps).toEqual([])
    expect((result.data.items as Data[]).find((i) => i.t === 'EDIT')?._key).toBe(M1)
  })

  it('deletes an item the base deleted that both versions held under other stale keys', () => {
    const page: FieldConfig[] = [
      { name: 'items', type: 'object', list: true, fields: text('h', 't', 'k') },
    ]
    const st = (s: string) => itemKeysAsRead([{ h: s, t: '0', k: '0' }])[0] as string
    const [x, y] = [
      { h: 'x', t: '1', k: 'a' },
      { h: 'y', t: '2', k: 'b' },
    ]
    const [w, v] = [
      { h: 'a', t: 'c', k: 'b' },
      { h: 'c', t: 'b', k: 'c' },
    ]
    const o = [x, y, { ...w, _key: st('w0') }, v]
    const branch = [x, y, { ...w, _key: st('w1') }, { ...v, _key: st('v1') }]
    const result = run(
      { data: { items: o } },
      { data: { items: [x, y] } },
      { data: { items: branch } },
      'json',
      page,
    )
    expect(result.conflicts).toEqual([])
    expect(result.data.items).toEqual([x, y])
  })

  it('with no schema, reads every list as keyed, so a twin list keeps its thread', () => {
    const x = { t: 'x', d: 'd' }
    const result = mergeEntry({
      format: 'json',
      ancestor: { data: { title: 'T', items: [x], l2: [x] } },
      base: { data: { title: 'T', items: [{ ...x, d: 'd2' }], l2: [x] } },
      branch: { data: { title: 'T2', items: [x], l2: [x] } },
    })
    expect(result.kind === 'merged' && result.keyRemaps).toEqual([])
  })

  it('reads a list the schema lacks as no ambiguity, so an item the base changed is re-keyed', () => {
    const page: FieldConfig[] = [
      { name: 'items', type: 'object', list: true, fields: text('t', 'd') },
    ]
    const x = { t: 'x', d: 'd' }
    const e1 = { t: 'x', d: 'e1' }
    const [hX, hE1] = [itemKeysAsRead([x])[0], itemKeysAsRead([e1])[0]]
    const result = run(
      { data: { items: [x], extra: [x] } },
      { data: { items: [e1], extra: [x] } },
      { data: { items: [{ ...x, _key: hX }], extra: [x] } },
      'json',
      page,
    )
    expect((result.data.items as Data[])[0]._key).toBe(hE1)
    expect(result.keyRemaps).toEqual([{ within: [], from: hX, to: hE1 }])
  })

  it('reads a key a person typed, matching one in another list, as no move', () => {
    const nested: FieldConfig[] = [
      {
        name: 'items',
        type: 'object',
        list: true,
        fields: [
          ...text('title'),
          { name: 'links', type: 'object', list: true, fields: text('href') },
        ],
      },
    ]
    const o = { items: [{ title: 'T', _key: '1', links: [{ href: '/0' }, { href: '/a' }] }] }
    const base = { items: [{ title: 'T', _key: '1', links: [{ href: '/0' }, { href: '/z' }] }] }
    const branch = {
      items: [
        {
          title: 'T2',
          _key: '1',
          links: [
            { href: '/0', _key: '0' },
            { href: '/a', _key: '1' },
          ],
        },
      ],
    }
    const result = run({ data: o }, { data: base }, { data: branch }, 'json', nested)
    expect(result.conflicts).toEqual([])
    expect(((result.data.items as Data[])[0].links as Data[]).map((l) => l.href)).toEqual([
      '/0',
      '/z',
    ])
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
    // 200 items sharing 30 values each: scoring them would match over a million values.
    const alike = Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`f${k}`, 'same']))
    const o = Array.from({ length: 200 }, (_, i) => ({ title: `t${i}`, detail: 'd', ...alike }))
    const result = run(
      { data: { items: o } },
      { data: { items: o.map((item) => ({ ...item, title: item.title.toUpperCase() })) } },
      { data: { items: o.filter((_, i) => i !== 100) } },
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

  it('an item the branch removed is named by the base key, as the drawer names it once landed', () => {
    const t = { title: 'T', detail: 'd' }
    const base = { items: [{ ...t, title: 'B' }] }
    const result = merge({ items: [t] }, base, { items: [] })
    const baseKey = itemKeysAsRead(base.items)[0]
    expect(kinds(result)).toEqual([{ key: `items.${baseKey}`, kind: 'removed-by-you', item: true }])
    // Once the merge lands the drawer compares the base, the branch's new merge base, with it.
    const drawer = computeEntryDiff({
      fields,
      before: { format: 'json', entryType: 'page', data: entryAsRead(fields, base) },
      after: { format: 'json', entryType: 'page', data: entryAsRead(fields, result.data) },
      marks: false,
    })
    expect(drawer.changes.map((c) => c.key)).toContain(`items.${baseKey}`)
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
  /**
   * The drawer's change for `conflict` once the merge lands: the drawer then compares the base,
   * the branch's new merge base, with the merged entry.
   */
  const drawerChange = (a: Data, merged: Data, conflict: Pick<FieldConflict, 'key'>) =>
    computeEntryDiff({
      fields,
      before: { format: 'json', entryType: 'page', data: entryAsRead(fields, a) },
      after: { format: 'json', entryType: 'page', data: entryAsRead(fields, merged) },
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
      const change = drawerChange(a, result.data, result.conflicts[0])
      expect(change?.key).toBe(result.conflicts[0].key)
      expect(change?.dataPath).toEqual(result.conflicts[0].dataPath)
    })
  }

  it('names where the branch holds an item the merge re-keyed by the base version as read', () => {
    const [o, a, b] = cases
      .find(([name]) => name === 'a field of an item the base left keyless')!
      .slice(1) as Data[]
    const result = mergeEntry({
      format: 'json',
      ancestor: { data: o },
      base: { data: a },
      branch: { data: b },
      fields,
    })
    if (result.kind !== 'merged') throw new Error('expected a merge')
    const [conflict] = result.conflicts
    const baseKey = itemKeysAsRead([{ title: 'B', detail: 'd' }])[0]
    expect(conflict.sidePaths.base).toEqual([
      { field: 'items' },
      { item: baseKey },
      { field: 'title' },
    ])
    // The merged item takes the base's read key, so only the branch's own path finds its value.
    expect(conflict.sidePaths.base).toEqual(conflict.dataPath)
    expect(conflict.sidePaths.branch).toEqual([
      { field: 'items' },
      { item: (b.items as Data[])[0]._key as string },
      { field: 'title' },
    ])
    const branchRead = entryAsRead(fields, b)
    expect(valueAtSidePath(branchRead, conflict.sidePaths.branch!)).toBe('M')
    expect(valueAtSidePath(branchRead, conflict.dataPath)).toBeUndefined()
  })
})

describe('side paths', () => {
  it('names an item a side lacks through the list it holds', () => {
    const o = { items: [item('k1', 'One')], other: [] as unknown[] }
    const a = { items: [] as unknown[], other: [item('k1', 'One')] }
    const b = { items: [item('k1', 'One, mine')], other: [] as unknown[] }
    const schema: FieldConfig[] = [
      { name: 'items', type: 'object', list: true, fields: text('title', 'detail') },
      { name: 'other', type: 'object', list: true, fields: text('title', 'detail') },
    ]
    const result = mergeEntry({
      format: 'json',
      ancestor: { data: o },
      base: { data: a },
      branch: { data: b },
      fields: schema,
    })
    if (result.kind !== 'merged') throw new Error('expected a merge')
    // The base took the item out of `items`: it is named by the list it holds, which lacks it.
    const moved = result.conflicts.find((c) => c.item)
    expect(moved?.kind).toBe('removed-on-base')
    expect(moved?.base).toBeUndefined()
    expect(moved?.sidePaths.base).toEqual([{ field: 'items' }])
    expect(moved?.sidePaths.ancestor).toEqual([{ field: 'items' }, { item: 'k1' }])
    expect(moved?.sidePaths.branch).toEqual([{ field: 'items' }, { item: 'k1' }])
    checkSidePaths(
      result.conflicts,
      { ancestor: { data: o }, base: { data: a }, branch: { data: b } },
      schema,
    )
  })

  it('names a value lifted whole in each version that holds it, a side lacking the leaf included', () => {
    // A block of a template the schema lacks is one value; the base took a row out of it.
    const schema: FieldConfig[] = [
      { name: 'blocks', type: 'block', templates: [{ name: 'hero', fields: text('title') }] },
    ]
    const [r1, r2] = [
      { t: 't', u: 'u' },
      { t: 'x', u: 'y' },
    ]
    const block = { template: 'legacy', value: { title: 'T', rows: [r1, r2] } }
    const o = { data: { blocks: [block] } }
    const a = { data: { blocks: [{ template: 'legacy', value: { title: 'T', rows: [r2] } }] } }
    const b = {
      data: {
        blocks: [
          {
            _key: itemKeysAsRead([block])[0],
            template: 'legacy',
            value: { title: 'T', rows: [{ t: 'tB', u: 'u' }, r2] },
          },
        ],
      },
    }
    const result = mergeEntry({ format: 'json', ancestor: o, base: a, branch: b, fields: schema })
    if (result.kind !== 'merged') throw new Error('expected a merge')
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0].base).toBeDefined()
    expect(result.conflicts[0].sidePaths.base).toEqual([
      { field: 'blocks' },
      { item: itemKeysAsRead(a.data.blocks)[0] },
    ])
    checkSidePaths(result.conflicts, { ancestor: o, base: a, branch: b }, schema)
  })

  it('names a nested item the base removed through the outer item the base keyed apart', () => {
    const schema: FieldConfig[] = [
      {
        name: 'items',
        type: 'object',
        list: true,
        fields: [
          ...text('name', 'n2'),
          { name: 'rows', type: 'object', list: true, fields: text('t', 'u') },
        ],
      },
    ]
    const [r1, r2] = [
      { t: 't', u: 'u' },
      { t: 'x', u: 'y' },
    ]
    const [k1, k2] = itemKeysAsRead([r1, r2])
    const outer = { name: 'n', n2: 'm', rows: [r1, r2] }
    const o = { data: { items: [outer] } }
    const a = { data: { items: [{ name: 'nA', n2: 'm', rows: [r2] }] } }
    const b = {
      data: {
        items: [
          {
            _key: itemKeysAsRead([outer])[0],
            name: 'n',
            n2: 'm',
            rows: [
              { _key: k1, t: 'tB', u: 'u' },
              { _key: k2, ...r2 },
            ],
          },
        ],
      },
    }
    const result = mergeEntry({ format: 'json', ancestor: o, base: a, branch: b, fields: schema })
    if (result.kind !== 'merged') throw new Error('expected a merge')
    const removed = result.conflicts.find((c) => c.kind === 'removed-on-base')
    expect(removed?.sidePaths.base).toEqual([
      { field: 'items' },
      { item: itemKeysAsRead(a.data.items)[0] },
      { field: 'rows' },
    ])
    checkSidePaths(result.conflicts, { ancestor: o, base: a, branch: b }, schema)
  })

  it('names an md body by its field on every side', () => {
    const result = run(
      { data: { title: 'T' }, body: 'one\ntwo\n' },
      { data: { title: 'T' }, body: 'one, base\ntwo\n' },
      { data: { title: 'T' }, body: 'one, mine\ntwo\n' },
      'md',
      [...fields, { name: 'content', type: 'markdown', isBody: true }],
    )
    expect(result.conflicts).toHaveLength(1)
  })
})
