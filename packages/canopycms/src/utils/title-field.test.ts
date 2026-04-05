import { describe, it, expect } from 'vitest'
import type { FieldConfig } from '../config'
import {
  extractTitleFromSchema,
  humanizeSlug,
  countTitleFields,
  resolveEntryTitle,
  findInvalidTitleFields,
} from './title-field'

describe('extractTitleFromSchema', () => {
  it('returns value of a top-level isTitle field', () => {
    const fields: FieldConfig[] = [
      { name: 'heading', type: 'string', isTitle: true },
      { name: 'body', type: 'markdown' },
    ]
    expect(extractTitleFromSchema(fields, { heading: 'Hello', body: '...' })).toBe('Hello')
  })

  it('returns value of a nested isTitle field inside an object', () => {
    const fields: FieldConfig[] = [
      {
        name: 'hero',
        type: 'object',
        fields: [
          { name: 'title', type: 'string', isTitle: true },
          { name: 'body', type: 'markdown' },
        ],
      },
      { name: 'cta', type: 'string' },
    ]
    const data = { hero: { title: 'Welcome', body: '...' }, cta: 'Click' }
    expect(extractTitleFromSchema(fields, data)).toBe('Welcome')
  })

  it('returns undefined when no field has isTitle', () => {
    const fields: FieldConfig[] = [
      { name: 'title', type: 'string' },
      { name: 'body', type: 'markdown' },
    ]
    expect(extractTitleFromSchema(fields, { title: 'Hi' })).toBeUndefined()
  })

  it('returns undefined when isTitle field value is not a string', () => {
    const fields: FieldConfig[] = [{ name: 'count', type: 'number', isTitle: true }]
    expect(extractTitleFromSchema(fields, { count: 42 })).toBeUndefined()
  })

  it('returns undefined when isTitle field is missing from data', () => {
    const fields: FieldConfig[] = [{ name: 'heading', type: 'string', isTitle: true }]
    expect(extractTitleFromSchema(fields, {})).toBeUndefined()
  })

  it('returns undefined when nested object is missing from data', () => {
    const fields: FieldConfig[] = [
      {
        name: 'hero',
        type: 'object',
        fields: [{ name: 'title', type: 'string', isTitle: true }],
      },
    ]
    expect(extractTitleFromSchema(fields, {})).toBeUndefined()
  })

  it('skips array-valued object fields', () => {
    const fields: FieldConfig[] = [
      {
        name: 'items',
        type: 'object',
        list: true,
        fields: [{ name: 'title', type: 'string', isTitle: true }],
      },
    ]
    // When the data is an array, we don't recurse into it
    expect(extractTitleFromSchema(fields, { items: [{ title: 'First' }] })).toBeUndefined()
  })
})

describe('humanizeSlug', () => {
  it('converts hyphens to spaces and capitalizes words', () => {
    expect(humanizeSlug('my-cool-page')).toBe('My Cool Page')
  })

  it('converts underscores to spaces and capitalizes words', () => {
    expect(humanizeSlug('about_us')).toBe('About Us')
  })

  it('handles single word', () => {
    expect(humanizeSlug('home')).toBe('Home')
  })
})

describe('countTitleFields', () => {
  it('returns 0 when no isTitle fields exist', () => {
    const fields: FieldConfig[] = [
      { name: 'title', type: 'string' },
      { name: 'body', type: 'markdown' },
    ]
    expect(countTitleFields(fields)).toBe(0)
  })

  it('returns 1 for a single top-level isTitle field', () => {
    const fields: FieldConfig[] = [
      { name: 'title', type: 'string', isTitle: true },
      { name: 'body', type: 'markdown' },
    ]
    expect(countTitleFields(fields)).toBe(1)
  })

  it('counts nested isTitle fields', () => {
    const fields: FieldConfig[] = [
      {
        name: 'hero',
        type: 'object',
        fields: [{ name: 'title', type: 'string', isTitle: true }],
      },
    ]
    expect(countTitleFields(fields)).toBe(1)
  })

  it('counts multiple isTitle fields across nesting levels', () => {
    const fields: FieldConfig[] = [
      { name: 'heading', type: 'string', isTitle: true },
      {
        name: 'meta',
        type: 'object',
        fields: [{ name: 'displayName', type: 'string', isTitle: true }],
      },
    ]
    expect(countTitleFields(fields)).toBe(2)
  })
})

describe('resolveEntryTitle', () => {
  it('uses isTitle field from schema when available', () => {
    const schema: FieldConfig[] = [{ name: 'heading', type: 'string', isTitle: true }]
    expect(resolveEntryTitle({ heading: 'My Title' }, { schema })).toBe('My Title')
  })

  it('falls back to data.title', () => {
    expect(resolveEntryTitle({ title: 'From Title' })).toBe('From Title')
  })

  it('falls back to data.name', () => {
    expect(resolveEntryTitle({ name: 'From Name' })).toBe('From Name')
  })

  it('prefers data.title over data.name', () => {
    expect(resolveEntryTitle({ title: 'Title', name: 'Name' })).toBe('Title')
  })

  it('falls back to entryTypeLabel', () => {
    expect(resolveEntryTitle({}, { entryTypeLabel: 'Blog Post' })).toBe('Blog Post')
  })

  it('falls back to humanized slug', () => {
    expect(resolveEntryTitle({}, { slug: 'my-cool-page' })).toBe('My Cool Page')
  })

  it('returns Untitled as last resort', () => {
    expect(resolveEntryTitle({})).toBe('Untitled')
  })

  it('isTitle schema takes priority over data.title convention', () => {
    const schema: FieldConfig[] = [
      { name: 'heading', type: 'string', isTitle: true },
      { name: 'title', type: 'string' },
    ]
    expect(
      resolveEntryTitle({ heading: 'Schema Title', title: 'Convention Title' }, { schema }),
    ).toBe('Schema Title')
  })

  it('falls through to convention when isTitle field is missing from data', () => {
    const schema: FieldConfig[] = [{ name: 'heading', type: 'string', isTitle: true }]
    expect(resolveEntryTitle({ title: 'Fallback' }, { schema })).toBe('Fallback')
  })
})

describe('findInvalidTitleFields', () => {
  it('returns empty array when no isTitle fields exist', () => {
    const fields: FieldConfig[] = [{ name: 'title', type: 'string' }]
    expect(findInvalidTitleFields(fields)).toEqual([])
  })

  it('returns empty array when isTitle is on a string field', () => {
    const fields: FieldConfig[] = [{ name: 'title', type: 'string', isTitle: true }]
    expect(findInvalidTitleFields(fields)).toEqual([])
  })

  it('returns field name when isTitle is on a non-string field', () => {
    const fields: FieldConfig[] = [{ name: 'count', type: 'number', isTitle: true }]
    expect(findInvalidTitleFields(fields)).toEqual(['count'])
  })

  it('returns dotted path for nested invalid fields', () => {
    const fields: FieldConfig[] = [
      {
        name: 'meta',
        type: 'object',
        fields: [{ name: 'order', type: 'number', isTitle: true }],
      },
    ]
    expect(findInvalidTitleFields(fields)).toEqual(['meta.order'])
  })
})
