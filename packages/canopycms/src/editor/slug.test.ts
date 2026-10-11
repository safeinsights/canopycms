import { describe, expect, it } from 'vitest'
import { slugFromTitle, validateEntrySlug } from './slug'

describe('slugFromTitle', () => {
  it('lowercases and hyphenates words', () => {
    expect(slugFromTitle('Hello World')).toBe('hello-world')
  })

  it('strips accents', () => {
    expect(slugFromTitle('Café Crème Brûlée')).toBe('cafe-creme-brulee')
  })

  it('spells & as and', () => {
    expect(slugFromTitle('Fish & Chips')).toBe('fish-and-chips')
  })

  it('collapses every run of punctuation and spaces into one hyphen', () => {
    expect(slugFromTitle("What's new?! -- (2026)")).toBe('what-s-new-2026')
  })

  it('trims leading and trailing separators', () => {
    expect(slugFromTitle('  ...Hello...  ')).toBe('hello')
  })

  it('cuts to 64 characters without leaving a trailing hyphen', () => {
    const title = `${'a'.repeat(63)} bbbb`
    const slug = slugFromTitle(title)
    expect(slug).toBe('a'.repeat(63))
    expect(slugFromTitle('word '.repeat(30)).length).toBeLessThanOrEqual(64)
    expect(slugFromTitle('word '.repeat(30)).endsWith('-')).toBe(false)
  })

  it('returns an empty string when no usable character remains', () => {
    expect(slugFromTitle('')).toBe('')
    expect(slugFromTitle('!!! ???')).toBe('')
    expect(slugFromTitle('日本語')).toBe('')
  })
})

describe('validateEntrySlug', () => {
  it('asks for a slug when empty or blank', () => {
    expect(validateEntrySlug('')).toBe('Enter a slug')
    expect(validateEntrySlug('   ')).toBe('Enter a slug')
  })

  it('accepts a well-formed slug', () => {
    expect(validateEntrySlug('my-post-2')).toBeNull()
  })

  it('rejects uppercase letters', () => {
    expect(validateEntrySlug('My-Post')).toBe('Use lowercase letters')
  })

  it('rejects path separators and traversal', () => {
    expect(validateEntrySlug('a/b')).toMatch(/path separators/)
    expect(validateEntrySlug('..')).toMatch(/traversal/)
  })

  it('rejects a slug over 64 characters', () => {
    expect(validateEntrySlug('a'.repeat(65))).toMatch(/too long/)
  })

  it('rejects a leading hyphen', () => {
    expect(validateEntrySlug('-abc')).toMatch(/start with a letter or number/)
  })

  it('rejects a slug another entry holds', () => {
    expect(validateEntrySlug('taken', { existingSlugs: new Set(['taken']) })).toBe(
      'An entry with this slug already exists',
    )
  })

  it('allows the slug the entry already has', () => {
    expect(
      validateEntrySlug('mine', { existingSlugs: new Set(['mine']), currentSlug: 'mine' }),
    ).toBeNull()
  })

  it('still rejects another entry slug when a different current slug is given', () => {
    expect(
      validateEntrySlug('taken', {
        existingSlugs: new Set(['taken', 'mine']),
        currentSlug: 'mine',
      }),
    ).toBe('An entry with this slug already exists')
  })
})
