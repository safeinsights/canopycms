import { describe, expect, it } from 'vitest'
import { entryDetailLine, matchesEntryQuery } from './entry-search'

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

  it("matches the title when it differs from the label, as a singleton's does", () => {
    expect(matchesEntryQuery({ label: 'Site settings', title: 'Example site' }, 'example')).toBe(
      true,
    )
    expect(matchesEntryQuery({ label: 'Site settings' }, 'example')).toBe(false)
  })

  it('does not match an entry with no slug on slug text', () => {
    expect(matchesEntryQuery({ label: 'Welcome' }, 'undefined')).toBe(false)
  })
})

describe('entryDetailLine', () => {
  it('joins the type and the route', () => {
    expect(entryDetailLine({ typeLabel: 'Landing page', route: '/contact' })).toBe(
      'Landing page · /contact',
    )
  })

  it('shows whichever of the two the entry has', () => {
    expect(entryDetailLine({ typeLabel: 'Landing page' })).toBe('Landing page')
    expect(entryDetailLine({ route: '/contact' })).toBe('/contact')
    expect(entryDetailLine({})).toBe('')
  })
})
