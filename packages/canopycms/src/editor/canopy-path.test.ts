import { describe, expect, it } from 'vitest'

import { formatCanopyPath, normalizeCanopyPath, parseCanopyPath } from './canopy-path'

describe('canopy path helpers', () => {
  it('formats segments with bracketed arrays', () => {
    expect(formatCanopyPath(['blocks', 0, 'title'])).toBe('blocks[0].title')
    expect(formatCanopyPath(['features', 3])).toBe('features[3]')
    expect(formatCanopyPath([0, 'title'])).toBe('[0].title')
  })

  it('parses dotted or bracketed input into segments', () => {
    expect(parseCanopyPath('blocks[1].cta.text')).toEqual(['blocks', 1, 'cta', 'text'])
    expect(parseCanopyPath('blocks.2.title')).toEqual(['blocks', 2, 'title'])
    expect(parseCanopyPath('[0].title')).toEqual([0, 'title'])
  })

  it('normalizes mixed input to canonical string', () => {
    expect(normalizeCanopyPath('blocks.0.title')).toBe('blocks[0].title')
    expect(normalizeCanopyPath(['blocks', 0, 'title'])).toBe('blocks[0].title')
    expect(normalizeCanopyPath('blocks[0].title')).toBe('blocks[0].title')
  })
})
