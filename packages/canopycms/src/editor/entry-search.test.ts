import { describe, expect, it } from 'vitest'
import { filterEntries, groupEntriesByCollection, matchesEntryQuery } from './entry-search'

const entries = [
  { label: 'Getting started', slug: 'getting-started', collectionPath: 'content/guides' },
  { label: 'Data access', slug: 'data-access', collectionPath: 'content/guides' },
  { label: 'Welcome', slug: 'home', collectionPath: 'content/pages', collectionName: 'pages' },
  { label: 'Loose entry' },
]

describe('matchesEntryQuery', () => {
  it('matches the label case-insensitively', () => {
    expect(matchesEntryQuery({ label: 'Getting Started' }, 'STARTED')).toBe(true)
    expect(matchesEntryQuery({ label: 'Getting Started' }, 'missing')).toBe(false)
  })

  it('matches the slug when the label does not', () => {
    expect(matchesEntryQuery({ label: 'Welcome', slug: 'home-page' }, 'home')).toBe(true)
  })

  it('trims the query, and an empty or blank query matches everything', () => {
    expect(matchesEntryQuery({ label: 'Welcome' }, '')).toBe(true)
    expect(matchesEntryQuery({ label: 'Welcome' }, '   ')).toBe(true)
    expect(matchesEntryQuery({ label: 'Welcome' }, '  wel ')).toBe(true)
    expect(matchesEntryQuery({ label: 'Welcome' }, '  xyz ')).toBe(false)
  })

  it('does not match an entry with no slug on slug text', () => {
    expect(matchesEntryQuery({ label: 'Welcome' }, 'undefined')).toBe(false)
  })
})

describe('filterEntries', () => {
  it('keeps only matching entries, in order', () => {
    expect(filterEntries(entries, 'data').map((e) => e.label)).toEqual(['Data access'])
    expect(filterEntries(entries, 'a').map((e) => e.label)).toEqual([
      'Getting started',
      'Data access',
    ])
  })

  it('returns everything for an empty query', () => {
    expect(filterEntries(entries, '')).toHaveLength(entries.length)
  })
})

describe('groupEntriesByCollection', () => {
  const headings = (groups: { heading: string }[]) => groups.map((g) => g.heading)

  it('prefers the labelFor heading, then collectionName, then collectionPath, then Root', () => {
    const groups = groupEntriesByCollection(entries, (path) =>
      path === 'content/guides' ? 'Guides' : undefined,
    )
    expect(headings(groups)).toEqual(['Guides', 'pages', 'Root'])
    expect(groups[0].entries.map((e) => e.label)).toEqual(['Getting started', 'Data access'])
  })

  it('prefers the labelFor heading over the collection name', () => {
    const groups = groupEntriesByCollection(
      [{ label: 'Welcome', collectionPath: 'content/pages', collectionName: 'pages' }],
      () => 'Pages',
    )
    expect(headings(groups)).toEqual(['Pages'])
  })

  it('falls back to collectionPath when there is no label and no name', () => {
    const groups = groupEntriesByCollection(entries)
    expect(headings(groups)).toEqual(['content/guides', 'pages', 'Root'])
  })

  it('keeps first-seen group order', () => {
    const groups = groupEntriesByCollection([
      { label: 'b', collectionPath: 'z' },
      { label: 'a', collectionPath: 'a' },
      { label: 'c', collectionPath: 'z' },
    ])
    expect(headings(groups)).toEqual(['z', 'a'])
    expect(groups[0].entries.map((e) => e.label)).toEqual(['b', 'c'])
  })

  it('keeps two collections that share a heading apart', () => {
    const groups = groupEntriesByCollection(
      [
        { label: 'a', collectionPath: 'guides/overview' },
        { label: 'b', collectionPath: 'news/overview' },
      ],
      () => 'Overview',
    )
    expect(groups.map((g) => g.entries.map((e) => e.label))).toEqual([['a'], ['b']])
  })
})
