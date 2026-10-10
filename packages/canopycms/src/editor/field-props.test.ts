import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  defineBlockTemplate,
  defineEntrySchema,
  defineInlineFieldGroup,
  defineNestedFieldGroup,
  type BlockValueOf,
  type TypeFromEntrySchema,
} from '../entry-schema'
import { createEntrySchemaRegistry } from '../entry-schema-registry'
import { createFieldProps, fieldAttrs, scopeFieldProps, type FieldProps } from './field-props'

const authorSchema = defineEntrySchema([
  { name: 'name', type: 'string' },
  { name: 'bio', type: 'string' },
])
const heroBlock = defineBlockTemplate({
  name: 'hero',
  fields: [
    { name: 'headline', type: 'string' },
    { name: 'image', type: 'image' },
  ],
})
const postsBlock = defineBlockTemplate({
  name: 'posts',
  fields: [
    { name: 'heading', type: 'string' },
    {
      name: 'posts',
      type: 'object',
      list: true,
      fields: [
        { name: 'title', type: 'string' },
        { name: 'category', type: 'string' },
      ],
    },
  ],
})
const pageSchema = defineEntrySchema([
  { name: 'title', type: 'string' },
  { name: 'tags', type: 'string', list: true },
  defineInlineFieldGroup({
    name: 'seo',
    fields: [{ name: 'metaTitle', type: 'string', required: false }],
  }),
  defineNestedFieldGroup({
    name: 'banner',
    fields: [
      { name: 'heading', type: 'string' },
      { name: 'items', type: 'object', list: true, fields: [{ name: 'text', type: 'string' }] },
    ],
  }),
  {
    name: 'author',
    type: 'reference',
    collections: ['content/authors'],
    resolvedSchema: authorSchema,
  },
  { name: 'related', type: 'reference', collections: ['content/posts'], list: true },
  { name: 'sections', type: 'block', templates: [heroBlock, postsBlock], required: false },
])
type Page = TypeFromEntrySchema<typeof pageSchema>
type Section = Page['sections'] extends (infer S)[] | undefined ? S : never
type PostsBlock = BlockValueOf<Section, 'posts'>
type HeroBlock = BlockValueOf<Section, 'hero'>

const fieldProps = createFieldProps<Page>()
const i = 2 as number

describe('the test schema', () => {
  it('is one a registry accepts', () => {
    expect(() => createEntrySchemaRegistry({ page: pageSchema })).not.toThrow()
  })
})

describe('fieldProps', () => {
  it('spells string and segment paths the way the form does', () => {
    expect(fieldProps('title')).toEqual({ 'data-canopy-path': 'title' })
    expect(fieldProps('sections.0.headline')).toEqual({
      'data-canopy-path': 'sections[0].headline',
    })
    expect(fieldProps('sections[0].headline')).toEqual({
      'data-canopy-path': 'sections[0].headline',
    })
    expect(fieldProps(['sections', i, 'posts', 1, 'title'])).toEqual({
      'data-canopy-path': 'sections[2].posts[1].title',
    })
  })

  it('emits nothing for an empty path', () => {
    expect(fieldProps([])).toEqual({})
    expect(fieldProps('')).toEqual({})
  })

  it('is one function across renders', () => {
    expect(createFieldProps<Page>()).toBe(fieldProps)
  })
})

describe('fieldAttrs', () => {
  it('marks the path on fieldProps', () => {
    expect(fieldAttrs(fieldProps, ['banner', 'heading'])).toEqual({
      'data-canopy-path': 'banner.heading',
    })
    expect(fieldAttrs(fieldProps, 'banner.items.3')).toEqual({
      'data-canopy-path': 'banner.items[3]',
    })
  })

  it('marks nothing without fieldProps, as on a public page', () => {
    const none: FieldProps<Page> | undefined = undefined
    expect(fieldAttrs(none, ['title'])).toEqual({})
  })
})

describe('scopeFieldProps', () => {
  it('prefixes the paths a component marks relative to its part', () => {
    const section = scopeFieldProps(fieldProps, ['sections', 3])
    expect(fieldAttrs(section, ['headline'])).toEqual({
      'data-canopy-path': 'sections[3].headline',
    })
    expect(fieldAttrs(section, [])).toEqual({ 'data-canopy-path': 'sections[3]' })

    const posts = scopeFieldProps(section, 'posts')
    expect(fieldAttrs(posts, [1, 'title'])).toEqual({
      'data-canopy-path': 'sections[3].posts[1].title',
    })
    expect(fieldAttrs(posts, '[1]')).toEqual({ 'data-canopy-path': 'sections[3].posts[1]' })
  })

  it('normalizes a dotted prefix', () => {
    const items = scopeFieldProps(fieldProps, 'banner.items.0')
    expect(fieldAttrs(items, 'text')).toEqual({ 'data-canopy-path': 'banner.items[0].text' })
  })

  it('returns undefined for undefined, so a public page builds no function', () => {
    expect(scopeFieldProps(undefined as FieldProps<Page> | undefined, ['banner'])).toBeUndefined()
  })
})

describe('FieldProps types', () => {
  it('accepts the paths the form has', () => {
    fieldProps('title')
    fieldProps('metaTitle')
    fieldProps('banner.items[0].text')
    fieldProps(['tags', i])
    fieldProps(['author'])
    fieldProps(['related', 0])
    fieldProps(['sections', i])
    fieldProps(['sections', i, 'posts', 0, 'category'])
    fieldProps(['sections', 0, 'image'])
    fieldProps([])
  })

  it('rejects a key the content does not have, at the step that goes wrong', () => {
    // @ts-expect-error - the field is `category`
    fieldProps(['sections', i, 'posts', 0, 'tag'])
    // @ts-expect-error - the field is `category`
    fieldProps('sections[0].posts[0].tag')
    // @ts-expect-error - `seo` is an inline group: its fields sit at the top level
    fieldProps('seo.metaTitle')
    // @ts-expect-error - a list takes an index, not a field
    fieldProps(['banner', 'items', 'text'])
    // @ts-expect-error - a block's fields follow its index directly, not under `value`
    fieldProps(['sections', 0, 'value', 'headline'])
  })

  it('stops at a reference, an image and a scalar', () => {
    // @ts-expect-error - the form edits a reference as one field
    fieldProps(['author', 'name'])
    // @ts-expect-error - the form edits an image as one field
    fieldProps('sections.0.image.alt')
    // @ts-expect-error - a string has no fields
    fieldProps(['title', 'length'])
  })

  it('rejects a computed string under a typed T, and takes it untyped', () => {
    const computed: string = `sections.${i}.headline`
    // @ts-expect-error - computed paths go in as segments
    fieldProps(computed)
    const untyped: FieldProps = fieldProps
    untyped(computed)
    untyped(['anything', 1, 'goes'])
  })

  it('types a scoped FieldProps against the value at its prefix', () => {
    const banner = scopeFieldProps(fieldProps, ['banner'])
    expectTypeOf(banner).toEqualTypeOf<FieldProps<Page['banner']> | undefined>()
    fieldAttrs(banner, ['items', 0, 'text'])
    // @ts-expect-error - `title` is the page's, not the banner's
    fieldAttrs(banner, ['title'])
    // @ts-expect-error - the prefix is checked too
    scopeFieldProps(fieldProps, ['banners'])
  })

  it('lets a block scope fit a component typed for one template', () => {
    const section = scopeFieldProps(fieldProps, ['sections', i])
    const hero: FieldProps<HeroBlock> | undefined = section
    const posts: FieldProps<PostsBlock> | undefined = section
    fieldAttrs(posts, ['posts', 0, 'title'])
    // @ts-expect-error - a posts block has no `headline`
    fieldAttrs(posts, ['headline'])
    void hero
  })

  it('refuses a FieldProps for unrelated content', () => {
    const banner = scopeFieldProps(fieldProps, ['banner'])
    // @ts-expect-error - a banner scope is not a hero block's
    const hero: FieldProps<HeroBlock> | undefined = banner
    void hero
  })

  it('assigns any typed FieldProps to the untyped escape hatch', () => {
    const banner = scopeFieldProps(fieldProps, 'banner')
    const untyped: FieldProps | undefined = banner
    expect(fieldAttrs(untyped, 'whatever.0')).toEqual({
      'data-canopy-path': 'banner.whatever[0]',
    })
  })

  it('leaves a nested unknown untyped below it', () => {
    const loose = createFieldProps<{
      meta: unknown
      data: Record<string, unknown>
      title: string
    }>()
    loose(['meta', 'x', 0])
    loose('meta.x.y')
    loose(['data', 'a', 'b'])
    // @ts-expect-error - typed members stay checked
    loose(['title', 'x'])
  })

  it('refuses a template literal with a number hole, like any computed string', () => {
    // @ts-expect-error - computed paths go in as segments
    fieldProps(`sections[${i}]`)
    // @ts-expect-error - computed paths go in as segments
    fieldProps(`sections.${i}.headline`)
    fieldProps(['sections', i, 'headline'])
  })

  it('refuses a computed segment array, whose length the type cannot see', () => {
    const computed: (string | number)[] = ['sections', i]
    // @ts-expect-error - computed paths go in as literal segments
    fieldProps(computed)
    // @ts-expect-error - a scope from one would be typed as the root
    scopeFieldProps(fieldProps, computed)
    const untyped: FieldProps = fieldProps
    untyped(computed)
  })

  it('treats nullable content as its non-null value', () => {
    const maybe = createFieldProps<Page | undefined>()
    maybe('title')
    // @ts-expect-error - still checked
    maybe('titl')
  })
})
