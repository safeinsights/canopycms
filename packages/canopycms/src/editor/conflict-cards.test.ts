import { describe, expect, it } from 'vitest'

import type { EntryChangeSide } from '../api/branch-entry-changes'
import type { EntryConflictData } from '../api/merge-conflicts'
import type { FieldConfig } from '../config'
import { itemKeysAsRead } from '../item-keys'
import { mergeEntry } from '../merge/entry-merge'
import { entryAsRead } from '../utils/calendar-day'
import { withLatest } from './conflict-choices'
import { buildEntryConflicts, type ConflictCard } from './conflict-cards'
import {
  ANCESTOR_SHA,
  BASE_SHA,
  conflictFields,
  fieldsConflictData,
  savedValue,
  keylessConflictData,
} from './components/__test__/conflict-fixtures'

const build = (...only: Parameters<typeof fieldsConflictData>[0][]) =>
  buildEntryConflicts(fieldsConflictData(...only), conflictFields, 'body')

const onlyCard = (cards: ConflictCard[]): ConflictCard => {
  expect(cards).toHaveLength(1)
  return cards[0]
}

describe('buildEntryConflicts', () => {
  it('shows a field changed on both sides with its three values and word marks', () => {
    const card = onlyCard(build(['summary']).fields[0].cards)
    expect(card).toMatchObject({
      type: 'value',
      conflict: 'changed',
      item: false,
      path: ['Summary'],
      before: { kind: 'text', text: 'How to begin.' },
      latest: { kind: 'text', text: 'How to begin editing.' },
      yours: { kind: 'text', text: 'A guide to your first edit.' },
    })
    if (card.type !== 'value') throw new Error('value card expected')
    expect(card.latestText?.mode).toBe('words')
    expect(card.yoursText?.mode).toBe('words')
  })

  it('names a conflict at depth by its labels down to the leaf (row 5)', () => {
    const card = onlyCard(build(['heading']).fields[0].cards)
    expect(card.path).toEqual(['Hero', 'Heading'])
    expect(card).toMatchObject({
      latest: { kind: 'text', text: 'Welcome, editors' },
      yours: { kind: 'text', text: 'Welcome aboard' },
    })
  })

  it('shows a field the latest version removed as empty there (row 7)', () => {
    const card = onlyCard(build(['readTime']).fields[0].cards)
    expect(card).toMatchObject({
      type: 'value',
      conflict: 'removed-on-base',
      path: ['Read time'],
      before: { kind: 'number', value: 4 },
      latest: { kind: 'empty' },
      yours: { kind: 'number', value: 6 },
    })
  })

  it('shows a field you removed as empty in yours (row 8)', () => {
    const card = onlyCard(build(['tagline']).fields[0].cards)
    expect(card).toMatchObject({
      conflict: 'removed-by-you',
      before: { kind: 'text', text: 'Start here' },
      latest: { kind: 'text', text: 'Start here today' },
      yours: { kind: 'empty' },
    })
  })

  it('shows a whole list item the latest version removed, with your edited item (row 14)', () => {
    const field = build(['step']).fields[0]
    expect(field.item).toBe(true)
    const card = onlyCard(field.cards)
    expect(card).toMatchObject({ type: 'value', item: true, conflict: 'removed-on-base' })
    expect(card.path).toEqual(['Steps', 'Configure'])
    if (card.type !== 'value') throw new Error('value card expected')
    expect(card.latest).toEqual({ kind: 'empty' })
    expect(JSON.stringify(card.yours)).toContain('Configure the site')
    expect(JSON.stringify(card.before)).toContain('Configure')
  })

  it('shows a value the drawer shows whole, an image, as one card', () => {
    const card = onlyCard(build(['cover']).fields[0].cards)
    expect(card).toMatchObject({
      type: 'value',
      path: ['Cover image'],
      latest: { kind: 'image', src: '/assets/b2/cover-site.jpg' },
      yours: { kind: 'image', src: '/assets/c3/cover-mine.jpg' },
    })
  })

  it('splits a body into one card per region both sides changed (rows 23, 24)', () => {
    const field = build(['body']).fields[0]
    expect(field.cards.map((c) => c.type)).toEqual(['region', 'region'])
    expect(field.cards.map((c) => c.id)).toEqual(['body#0', 'body#1'])
    expect(field.cards[0]).toMatchObject({
      index: 0,
      count: 2,
      before: 'Install the package first.',
      latest: 'Install the package with pnpm first.',
      yours: 'Install the package and its peers first.',
    })
    expect(field.cards[1]).toMatchObject({
      before: 'Ask for help in the forum.',
      latest: 'Ask for help in the chat.',
      yours: 'Ask for help on the issue tracker.',
    })
    // The heading only the latest version changed merged by itself: it is no region.
    expect(field.text?.merged.startsWith('# Welcome, editors\n')).toBe(true)
  })

  it('shows a value the merge compared whole, with no change of the drawer at its key, whole', () => {
    // A merge without the schema names a list as one field: the drawer's diff has only its items.
    const data = fieldsConflictData([])
    data.fields = [
      {
        key: '?steps',
        drawerKey: 'steps',
        dataPath: [{ field: 'steps' }],
        sidePaths: {
          ancestor: [{ field: 'steps' }],
          base: [{ field: 'steps' }],
          branch: [{ field: 'steps' }],
        },
        kind: 'changed',
        mergeSha: 'd'.repeat(40),
        sides: data.sides,
      },
    ]
    const card = onlyCard(buildEntryConflicts(data, conflictFields, 'body').fields[0].cards)
    expect(card).toMatchObject({ type: 'value', path: ['Steps'] })
    if (card.type !== 'value') throw new Error('value card expected')
    expect(card.latest.kind).toBe('list')
    expect(JSON.stringify(card.before)).toContain('Configure')
    expect(JSON.stringify(card.latest)).not.toContain('Configure')
    expect(JSON.stringify(card.yours)).toContain('Configure the site')
  })

  it('gives the entry place its own card, with no versions to compare', () => {
    expect(onlyCard(build(['location']).fields[0].cards)).toMatchObject({
      type: 'location',
      key: '@location',
    })
  })

  it('carries each conflict’s key and merge for the save that resolves it', () => {
    const fields = build().fields
    expect(fields.map((f) => f.key)).toEqual([
      'summary',
      'hero.heading',
      'readTime',
      'tagline',
      'steps.k2',
      'cover',
      'body',
      '@location',
    ])
    expect(fields.every((f) => f.mergeSha === 'd'.repeat(40))).toBe(true)
  })

  it('still builds cards, saying so, when a version could not be read', () => {
    const data = fieldsConflictData(['summary'])
    data.versions[BASE_SHA] = { unavailable: 'too-large' }
    const built = buildEntryConflicts(data, conflictFields, 'body')
    expect(built.incomplete).toBe(true)
    expect(onlyCard(built.fields[0].cards)).toMatchObject({
      path: ['Summary'],
      before: { kind: 'text', text: 'How to begin.' },
    })
    expect(data.versions[ANCESTOR_SHA]).toBeDefined()
  })

  it('shows long text whole once your saved text is no longer the text the merge left', () => {
    const data = fieldsConflictData(['body'])
    const saved = { ...savedValue, body: `${String(savedValue.body)}Typed since.\n` }
    const field = buildEntryConflicts(data, conflictFields, 'body', undefined, saved).fields[0]
    expect(field.text).toBeUndefined()
    expect(field.cards.map((c) => c.type)).toEqual(['value'])
    // While your saved text is the merge's, the regions stand.
    const same = buildEntryConflicts(data, conflictFields, 'body', undefined, savedValue)
    expect(same.fields[0].cards.map((c) => c.type)).toEqual(['region', 'region'])
  })

  it('shows your saved value as yours once a save since the merge changed it', () => {
    const saved = { ...savedValue, summary: 'Saved after the merge.' }
    const card = onlyCard(
      buildEntryConflicts(fieldsConflictData(['summary']), conflictFields, 'body', undefined, saved)
        .fields[0].cards,
    )
    expect(card).toMatchObject({ yours: { kind: 'text', text: 'Saved after the merge.' } })
    // Unchanged since the merge, yours is the branch's version as before.
    const same = onlyCard(
      buildEntryConflicts(
        fieldsConflictData(['summary']),
        conflictFields,
        'body',
        undefined,
        savedValue,
      ).fields[0].cards,
    )
    expect(same).toMatchObject({ yours: { kind: 'text', text: 'A guide to your first edit.' } })
  })

  it('shows each version at its own place, for an item the latest version keyed apart', () => {
    const { fields, incomplete } = buildEntryConflicts(
      keylessConflictData(),
      conflictFields,
      'body',
    )
    expect(incomplete).toBe(false)
    expect(fields[0].latestPlaceable).toBe(true)
    expect(fields[0].cards[0]).toMatchObject({
      type: 'value',
      before: { kind: 'text', text: 'Configure' },
      latest: { kind: 'text', text: 'Configure the editor' },
      yours: { kind: 'text', text: 'Configure the site' },
    })
    expect(fields[0].cards[0]).not.toHaveProperty('latestUnavailable')
  })

  it("shows a version it can't key as the merge named it as one it can't show", () => {
    // Another item of the latest version already holds the merged key, so the merged path would
    // find that one.
    const data = keylessConflictData()
    const latestVersion = data.versions[BASE_SHA] as EntryChangeSide
    data.versions[BASE_SHA] = {
      ...latestVersion,
      data: {
        ...latestVersion.data,
        steps: [
          { _key: 'k2', text: 'Another item' },
          { _key: 'kLatest', text: 'Configure the editor' },
        ],
      },
    }
    const { fields, incomplete } = buildEntryConflicts(data, conflictFields, 'body')
    expect(incomplete).toBe(true)
    expect(fields[0].latestPlaceable).toBe(false)
    expect(fields[0].cards[0]).toMatchObject({ latestUnavailable: true })
    expect(JSON.stringify(fields[0].cards[0])).not.toContain('Another item')
  })

  it('lets the latest version take out a nested item, inside an item it keyed apart', () => {
    // The base removed a row and reworded the outer item, in lists it left keyless; you edited the
    // row. The merge's own output, as the API serves it.
    const schema: FieldConfig[] = [
      {
        name: 'items',
        type: 'object',
        list: true,
        fields: [
          { name: 'name', type: 'string' },
          { name: 'n2', type: 'string' },
          {
            name: 'rows',
            type: 'object',
            list: true,
            fields: [
              { name: 't', type: 'string' },
              { name: 'u', type: 'string' },
            ],
          },
        ],
      },
    ]
    const [r1, r2] = [
      { t: 't', u: 'u' },
      { t: 'x', u: 'y' },
    ]
    const [k1, k2] = itemKeysAsRead([r1, r2])
    const outer = { name: 'n', n2: 'm', rows: [r1, r2] }
    const outerKey = itemKeysAsRead([outer])[0]
    const versions = {
      ancestor: { items: [outer] },
      base: { items: [{ name: 'nA', n2: 'm', rows: [r2] }] },
      branch: {
        items: [
          {
            _key: outerKey,
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
    const merged = mergeEntry({
      format: 'json',
      ancestor: { data: versions.ancestor },
      base: { data: versions.base },
      branch: { data: versions.branch },
      fields: schema,
    })
    if (merged.kind !== 'merged') throw new Error('expected a merge')
    const shas = { ancestor: 'a'.repeat(40), base: 'b'.repeat(40), branch: 'c'.repeat(40) }
    const asServed = (data: Record<string, unknown>) => ({
      format: 'json' as const,
      entryType: 'page',
      data: entryAsRead(schema, data),
    })
    const data: EntryConflictData = {
      contentId: 'pg0000000001',
      kind: 'fields',
      path: 'content/pages/page.home.pg0000000001.json',
      logicalPath: 'content/pages/home',
      mergeSha: 'd'.repeat(40),
      sides: shas,
      fields: merged.conflicts.map((c) => ({
        key: c.key,
        drawerKey: c.key,
        dataPath: c.dataPath,
        sidePaths: c.sidePaths,
        kind: c.kind,
        ...(c.item && { item: true as const }),
        mergeSha: 'd'.repeat(40),
        sides: shas,
      })),
      versions: {
        [shas.ancestor]: asServed(versions.ancestor),
        [shas.base]: asServed(versions.base),
        [shas.branch]: asServed(versions.branch),
      },
    }
    // The merge re-keys the outer item as the base's version reads: the form holds it there.
    const saved = entryAsRead(schema, merged.data)
    const baseOuterKey = itemKeysAsRead(versions.base.items)[0]
    const built = buildEntryConflicts(data, schema, undefined, undefined, saved)
    const removed = built.fields.find((f) => f.key === `items.${baseOuterKey}.rows.${k1}`)
    expect(removed?.latestPlaceable).toBe(true)
    const placed = withLatest(saved, removed!, undefined)
    const rows = (placed?.items as Array<{ rows: Array<{ _key: string }> }>)[0].rows
    expect(rows.map((r) => r._key)).toEqual([k2])
  })

  /** The cards for a real merge of three versions, as the API would serve them, on the merged form. */
  const throughCards = (
    schema: FieldConfig[],
    ...[ancestor, base, branch]: Array<Record<string, unknown>>
  ) => {
    const merged = mergeEntry({
      format: 'json',
      ancestor: { data: ancestor },
      base: { data: base },
      branch: { data: branch },
      fields: schema,
    })
    if (merged.kind !== 'merged') throw new Error('expected a merge')
    const shas = { ancestor: 'a'.repeat(40), base: 'b'.repeat(40), branch: 'c'.repeat(40) }
    const asServed = (data: Record<string, unknown>) => ({
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
      sides: shas,
      fields: merged.conflicts.map((c) => ({
        key: c.key,
        drawerKey: c.key,
        dataPath: c.dataPath,
        sidePaths: c.sidePaths,
        kind: c.kind,
        ...(c.item && { item: true as const }),
        mergeSha: 'd'.repeat(40),
        sides: shas,
      })),
      versions: {
        [shas.ancestor]: asServed(ancestor),
        [shas.base]: asServed(base),
        [shas.branch]: asServed(branch),
      },
    }
    const saved = entryAsRead(schema, structuredClone(merged.data))
    return { built: buildEntryConflicts(data, schema, undefined, undefined, saved), saved }
  }
  const titled: FieldConfig[] = [
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
  const titles = (value: Record<string, unknown> | undefined) =>
    (value?.items as Array<{ title: string }>).map((item) => item.title)

  it('takes out the item the latest version removed, not another holding its key there', () => {
    // The base removed the first of two alike items; its read keys the one it kept as the merge
    // named the removed one.
    const ancestor = { items: [{ title: 'C' }, { title: 'D' }, { title: 'C' }] }
    const read = entryAsRead(titled, structuredClone(ancestor)) as {
      items: Record<string, unknown>[]
    }
    const branch = { items: [{ ...read.items[0], title: 'DB' }, read.items[1], read.items[2]] }
    const { built, saved } = throughCards(
      titled,
      ancestor,
      { items: [{ title: 'D' }, { title: 'C' }] },
      branch,
    )
    const removed = built.fields.find((f) => f.item)!
    expect(removed.cards[0]).not.toMatchObject({ latest: { kind: 'text', text: 'C' } })
    expect(titles(withLatest(saved, removed, undefined))).toEqual(['D', 'C'])
  })

  it('puts back an item you removed where the latest version has it, among items keyed otherwise', () => {
    const ancestor = {
      items: [
        { title: 'A', note: 'n' },
        { title: 'X', note: 'n' },
        { title: 'C', note: 'n' },
      ],
    }
    const read = entryAsRead(titled, structuredClone(ancestor)) as {
      items: Record<string, unknown>[]
    }
    const base = {
      items: [
        { title: 'A', note: 'n2' },
        { title: 'X2', note: 'n' },
        { title: 'C', note: 'n' },
      ],
    }
    const branch = { items: [{ ...read.items[0], title: 'A3' }, read.items[2]] }
    const { built, saved } = throughCards(titled, ancestor, base, branch)
    const removed = built.fields.find((f) => f.item && f.cards[0]?.type === 'value')!
    expect(titles(withLatest(saved, removed, undefined))).toEqual(['A3', 'X2', 'C'])
  })
})
