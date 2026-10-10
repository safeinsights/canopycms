import { describe, expect, it } from 'vitest'

import {
  formatCanopyPath,
  isPathFieldName,
  normalizeCanopyPath,
  parseCanopyPath,
} from './canopy-path'

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

describe('normalizeCanopyPath', () => {
  it('re-parses segments, so a numeric or dotted string segment spells the same path', () => {
    expect(normalizeCanopyPath(['sections', '0', 'heading'])).toBe('sections[0].heading')
    expect(normalizeCanopyPath(['sections.0', 'heading'])).toBe('sections[0].heading')
    expect(normalizeCanopyPath([])).toBe('')
  })
})

describe('isPathFieldName', () => {
  it('refuses names a path cannot spell', () => {
    expect(isPathFieldName('title')).toBe(true)
    expect(isPathFieldName('item2')).toBe(true)
    expect(isPathFieldName('2024')).toBe(false)
    expect(isPathFieldName('a.b')).toBe(false)
    expect(isPathFieldName('a[0]')).toBe(false)
    expect(isPathFieldName('a]')).toBe(false)
    expect(isPathFieldName('')).toBe(false)
  })
})
