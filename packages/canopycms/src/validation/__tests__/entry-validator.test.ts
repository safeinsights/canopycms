import { describe, expect, it } from 'vitest'

import type { EntrySchema } from '../../config'
import {
  findUnknownKeys,
  mergeBodyIntoData,
  normalizeReferenceValues,
  referenceValueId,
  validateEntryData,
  validateEntryFormValue,
} from '../entry-validator'

const schema: EntrySchema = [
  { name: 'title', type: 'string', required: true },
  { name: 'views', type: 'number' },
  { name: 'published', type: 'boolean' },
  { name: 'publishedAt', type: 'datetime' },
  { name: 'category', type: 'select', options: ['news', 'opinion'] },
  { name: 'tags', type: 'string', list: true },
  { name: 'author', type: 'reference', required: true },
  {
    name: 'hero',
    type: 'object',
    fields: [{ name: 'headline', type: 'string', required: true }],
  },
  {
    name: 'blocks',
    type: 'block',
    templates: [
      {
        name: 'quote',
        fields: [
          { name: 'text', type: 'string', required: true },
          { name: 'source', type: 'reference' },
        ],
      },
    ],
  },
]

const validData = {
  title: 'Hello',
  author: '5NVkkrB1MJUv',
}

describe('validateEntryData', () => {
  it('accepts valid data', () => {
    expect(validateEntryData(schema, validData)).toEqual([])
  })

  it('rejects a missing required field', () => {
    const errors = validateEntryData(schema, { author: '5NVkkrB1MJUv' })
    expect(errors).toEqual([{ fieldPath: 'title', message: 'This field is required' }])
  })

  it('rejects an empty required string', () => {
    const errors = validateEntryData(schema, { ...validData, title: '   ' })
    expect(errors).toEqual([{ fieldPath: 'title', message: 'This field is required' }])
  })

  it('rejects wrong-typed values', () => {
    const errors = validateEntryData(schema, {
      ...validData,
      title: 42,
      views: 'many',
      published: 'yes',
      publishedAt: 'not-a-date',
    })
    const paths = errors.map((e) => e.fieldPath)
    expect(paths).toEqual(expect.arrayContaining(['title', 'views', 'published', 'publishedAt']))
  })

  it('rejects a select value outside its options', () => {
    const errors = validateEntryData(schema, { ...validData, category: 'sports' })
    expect(errors).toEqual([{ fieldPath: 'category', message: 'Must be one of: news, opinion' }])
  })

  it('rejects a non-array value for a list field', () => {
    const errors = validateEntryData(schema, { ...validData, tags: 'typed' })
    expect(errors).toEqual([{ fieldPath: 'tags', message: 'Expected a list of values' }])
  })

  it('validates each list item with an indexed path', () => {
    const errors = validateEntryData(schema, { ...validData, tags: ['ok', 7] })
    expect(errors).toEqual([{ fieldPath: 'tags[1]', message: 'Expected text' }])
  })

  it('rejects an empty required reference', () => {
    const errors = validateEntryData(schema, { ...validData, author: '' })
    expect(errors).toEqual([{ fieldPath: 'author', message: 'This field is required' }])
  })

  it('accepts a resolved reference object with an id', () => {
    const errors = validateEntryData(schema, {
      ...validData,
      author: { id: '5NVkkrB1MJUv', slug: 'alice' },
    })
    expect(errors).toEqual([])
  })

  it('validates fields nested in objects', () => {
    const errors = validateEntryData(schema, { ...validData, hero: { headline: '' } })
    expect(errors).toEqual([{ fieldPath: 'hero.headline', message: 'This field is required' }])
  })

  it('validates block-nested fields via the {template,value} shape', () => {
    const errors = validateEntryData(schema, {
      ...validData,
      blocks: [
        { template: 'quote', value: { text: 'fine' } },
        { template: 'quote', value: { text: '' } },
      ],
    })
    expect(errors).toEqual([{ fieldPath: 'blocks[1].text', message: 'This field is required' }])
  })

  it('rejects block items with an unknown template', () => {
    const errors = validateEntryData(schema, {
      ...validData,
      blocks: [{ template: 'nope', value: {} }],
    })
    expect(errors).toEqual([{ fieldPath: 'blocks[0]', message: 'Unknown block template "nope"' }])
  })

  it('sees fields inside inline groups at the parent data level', () => {
    const grouped: EntrySchema = [
      {
        type: 'group',
        name: 'meta',
        fields: [{ name: 'slugline', type: 'string', required: true }],
      },
    ]
    expect(validateEntryData(grouped, {})).toEqual([
      { fieldPath: 'slugline', message: 'This field is required' },
    ])
    expect(validateEntryData(grouped, { slugline: 'ok' })).toEqual([])
  })

  it('skips type checks for custom field types', () => {
    const custom: EntrySchema = [{ name: 'widget', type: 'my-widget', required: true }]
    expect(validateEntryData(custom, { widget: { anything: true } })).toEqual([])
    expect(validateEntryData(custom, {})).toEqual([
      { fieldPath: 'widget', message: 'This field is required' },
    ])
  })
})

describe('validateEntryData - image fields', () => {
  const imageSchema: EntrySchema = [{ name: 'hero', type: 'image' }]
  const altOptionalSchema: EntrySchema = [{ name: 'hero', type: 'image', altOptional: true }]

  it('accepts a full valid image object', () => {
    const errors = validateEntryData(imageSchema, {
      hero: {
        src: '/assets/hero.jpg',
        alt: 'A hero image',
        width: 800,
        height: 600,
        crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
      },
    })
    expect(errors).toEqual([])
  })

  it('accepts a minimal { src, alt } image object', () => {
    expect(
      validateEntryData(imageSchema, { hero: { src: '/assets/hero.jpg', alt: 'Hero' } }),
    ).toEqual([])
  })

  it('rejects a bare string value', () => {
    const errors = validateEntryData(imageSchema, { hero: '/assets/hero.jpg' })
    expect(errors).toEqual([
      { fieldPath: 'hero', message: 'Expected an image object with { src, alt }' },
    ])
  })

  it('rejects a missing/empty src', () => {
    expect(validateEntryData(imageSchema, { hero: { src: '', alt: 'Hero' } })).toEqual([
      { fieldPath: 'hero.src', message: 'Image src is required' },
    ])
    expect(validateEntryData(imageSchema, { hero: { alt: 'Hero' } })).toEqual([
      { fieldPath: 'hero.src', message: 'Image src is required' },
    ])
  })

  it('rejects an empty alt unless altOptional is set', () => {
    expect(validateEntryData(imageSchema, { hero: { src: '/x.jpg', alt: '' } })).toEqual([
      { fieldPath: 'hero.alt', message: 'Image alt text is required' },
    ])
    expect(validateEntryData(altOptionalSchema, { hero: { src: '/x.jpg', alt: '' } })).toEqual([])
  })

  it('rejects a negative or non-integer width/height', () => {
    const errors = validateEntryData(imageSchema, {
      hero: { src: '/x.jpg', alt: 'x', width: -5, height: 1.5 },
    })
    expect(errors).toEqual(
      expect.arrayContaining([
        { fieldPath: 'hero.width', message: 'Image width must be a positive integer' },
        { fieldPath: 'hero.height', message: 'Image height must be a positive integer' },
      ]),
    )
  })

  it('rejects a crop rect that is out of bounds', () => {
    const errors = validateEntryData(imageSchema, {
      hero: { src: '/x.jpg', alt: 'x', crop: { x: 0.6, y: 0, w: 0.6, h: 0.5 } },
    })
    expect(errors).toEqual([{ fieldPath: 'hero.crop', message: 'Invalid image crop rect' }])
  })

  it('rejects a crop rect with a non-positive w/h', () => {
    const errors = validateEntryData(imageSchema, {
      hero: { src: '/x.jpg', alt: 'x', crop: { x: 0, y: 0, w: 0, h: 0.5 } },
    })
    expect(errors).toEqual([{ fieldPath: 'hero.crop', message: 'Invalid image crop rect' }])
  })
})

describe('mergeBodyIntoData / validateEntryFormValue', () => {
  const mdSchema: EntrySchema = [
    { name: 'title', type: 'string', required: true },
    { name: 'body', type: 'mdx', isBody: true, required: true },
  ]

  it('merges the body under the schema body field name', () => {
    expect(mergeBodyIntoData(mdSchema, { title: 'x' }, '# hi')).toEqual({
      title: 'x',
      body: '# hi',
    })
  })

  it('validates the body as a required field for md/mdx form values', () => {
    expect(validateEntryFormValue(mdSchema, 'mdx', { title: 'x', body: '' })).toEqual([
      { fieldPath: 'body', message: 'This field is required' },
    ])
    expect(validateEntryFormValue(mdSchema, 'mdx', { title: 'x', body: '# hi' })).toEqual([])
  })

  it('validates data-only formats as-is', () => {
    expect(
      validateEntryFormValue([{ name: 'title', type: 'string', required: true }], 'json', {}),
    ).toEqual([{ fieldPath: 'title', message: 'This field is required' }])
  })
})

describe('referenceValueId / normalizeReferenceValues', () => {
  it('extracts ids from strings and resolved objects', () => {
    expect(referenceValueId('abc')).toBe('abc')
    expect(referenceValueId({ id: 'abc', slug: 's' })).toBe('abc')
    expect(referenceValueId(7)).toBeUndefined()
    expect(referenceValueId(null)).toBeUndefined()
  })

  it('collapses resolved reference objects to id strings, including inside blocks', () => {
    const normalized = normalizeReferenceValues(schema, {
      ...validData,
      author: { id: '5NVkkrB1MJUv', slug: 'alice' },
      blocks: [{ template: 'quote', value: { text: 'q', source: { id: 'jm6FYVAtJie8' } } }],
    })
    expect(normalized.author).toBe('5NVkkrB1MJUv')
    expect(normalized.blocks).toEqual([
      { template: 'quote', value: { text: 'q', source: 'jm6FYVAtJie8' } },
    ])
  })

  it('does not mutate the input data', () => {
    const data = { ...validData, author: { id: '5NVkkrB1MJUv' } }
    normalizeReferenceValues(schema, data)
    expect(data.author).toEqual({ id: '5NVkkrB1MJUv' })
  })
})

describe('findUnknownKeys', () => {
  it('returns nothing for data that matches the schema', () => {
    expect(findUnknownKeys(schema, validData)).toEqual([])
  })

  it('reports a top-level key with no schema counterpart', () => {
    expect(findUnknownKeys(schema, { ...validData, subtitle: 'stale' })).toEqual(['subtitle'])
  })

  it('reports keys inside an object field, path-qualified', () => {
    expect(
      findUnknownKeys(schema, { ...validData, hero: { headline: 'Hi', kicker: 'stale' } }),
    ).toEqual(['hero.kicker'])
  })

  it('reports keys inside each item of an object list', () => {
    const listSchema: EntrySchema = [
      {
        name: 'cards',
        type: 'object',
        list: true,
        fields: [{ name: 'label', type: 'string' }],
      },
    ]
    expect(
      findUnknownKeys(listSchema, {
        cards: [{ label: 'One' }, { label: 'Two', href: '/two' }],
      }),
    ).toEqual(['cards[1].href'])
  })

  it('reports keys inside a block item and never its template discriminator', () => {
    expect(
      findUnknownKeys(schema, {
        ...validData,
        blocks: [{ template: 'quote', value: { text: 'Hi', attribution: 'stale' } }],
      }),
    ).toEqual(['blocks[0].attribution'])
  })

  it('never reports the discriminator of the inline `_type` block shape', () => {
    expect(
      findUnknownKeys(schema, {
        ...validData,
        blocks: [{ _type: 'quote', text: 'Hi' }],
      }),
    ).toEqual([])
  })

  it('treats an inline group as transparent, reporting at the parent level', () => {
    const groupSchema: EntrySchema = [
      {
        name: 'seo',
        type: 'group',
        fields: [{ name: 'metaTitle', type: 'string' }],
      },
    ]
    expect(findUnknownKeys(groupSchema, { metaTitle: 'Hi' })).toEqual([])
    expect(findUnknownKeys(groupSchema, { metaTitle: 'Hi', metaDesc: 'stale' })).toEqual([
      'metaDesc',
    ])
  })

  it('does not descend into a resolved reference value', () => {
    // Reads resolve references by default, so a reference field's value carries the target's own
    // data plus the reserved id/slug/collection/urlPath keys. None of those are entry keys.
    expect(
      findUnknownKeys(schema, {
        ...validData,
        author: {
          id: '5NVkkrB1MJUv',
          slug: 'jane',
          collection: 'content/authors',
          urlPath: '/authors/jane',
          name: 'Jane',
          bio: 'Writer',
        },
      }),
    ).toEqual([])
  })

  it('reports nothing when the schema is empty — no schema is not "everything is unknown"', () => {
    expect(findUnknownKeys([], { anything: 1, atAll: 2 })).toEqual([])
  })

  it('reports nothing for a schema field that is simply absent from the data', () => {
    expect(findUnknownKeys(schema, { author: '5NVkkrB1MJUv' })).toEqual([])
  })
})

describe('findUnknownKeys — inline groups are not containers', () => {
  const groupWithSiblings: EntrySchema = [
    { name: 'title', type: 'string' },
    {
      name: 'seo',
      type: 'group',
      fields: [{ name: 'metaTitle', type: 'string' }],
    },
  ]

  it('does not report a sibling of a group as unknown', () => {
    // A group re-enters the traversal with the same record. Treating it as its own container
    // would hand the check only [metaTitle] and make `title` read as unknown.
    expect(findUnknownKeys(groupWithSiblings, { title: 'Hi', metaTitle: 'Hi' })).toEqual([])
  })

  it('reports an unknown key exactly once when a group is present', () => {
    expect(findUnknownKeys(groupWithSiblings, { title: 'Hi', stale: 1 })).toEqual(['stale'])
  })

  it('still reports inside an object nested under a group', () => {
    const nested: EntrySchema = [
      {
        name: 'seo',
        type: 'group',
        fields: [
          {
            name: 'og',
            type: 'object',
            fields: [{ name: 'image', type: 'string' }],
          },
        ],
      },
    ]
    expect(findUnknownKeys(nested, { og: { image: '/a.png', legacyAlt: 'stale' } })).toEqual([
      'og.legacyAlt',
    ])
  })
})
