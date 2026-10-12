import { describe, expect, it } from 'vitest'

import { parseMediaLibraryPrefs } from './media-library-prefs'

const DEFAULTS = { sort: 'newest', density: 'grid' }

describe('parseMediaLibraryPrefs', () => {
  it('reads valid stored preferences', () => {
    expect(parseMediaLibraryPrefs('{"sort":"name","density":"list"}')).toEqual({
      sort: 'name',
      density: 'list',
    })
  })

  it('returns the defaults for missing, malformed or non-object input', () => {
    for (const raw of [undefined, '', '{not json', 'null', '[]', '"name"', '7']) {
      expect(parseMediaLibraryPrefs(raw)).toEqual(DEFAULTS)
    }
  })

  it('replaces only the field that is invalid', () => {
    expect(parseMediaLibraryPrefs('{"sort":"oldest","density":"compact"}')).toEqual({
      sort: 'newest',
      density: 'compact',
    })
    expect(parseMediaLibraryPrefs('{"sort":"name","density":42}')).toEqual({
      sort: 'name',
      density: 'grid',
    })
  })
})
