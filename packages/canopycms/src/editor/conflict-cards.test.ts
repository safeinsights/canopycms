import { describe, expect, it } from 'vitest'

import { buildEntryConflicts, type ConflictCard } from './conflict-cards'
import {
  ANCESTOR_SHA,
  BASE_SHA,
  conflictFields,
  fieldsConflictData,
  savedValue,
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
})
