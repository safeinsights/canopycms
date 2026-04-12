import { describe, expect, it, expectTypeOf } from 'vitest'
import {
  defineEntrySchema,
  defineInlineFieldGroup,
  defineNestedFieldGroup,
  type TypeFromEntrySchema,
} from './entry-schema'

describe('TypeFromEntrySchema', () => {
  describe('block discriminated union', () => {
    it('produces a discriminated union, not a merged object', () => {
      const schema = defineEntrySchema([
        {
          name: 'blocks',
          type: 'block',
          templates: [
            {
              name: 'hero',
              label: 'Hero',
              fields: [
                { name: 'headline', type: 'string' },
                { name: 'body', type: 'markdown' },
              ],
            },
            {
              name: 'cta',
              label: 'CTA',
              fields: [
                { name: 'title', type: 'string' },
                { name: 'ctaText', type: 'string' },
              ],
            },
          ],
        },
      ])

      type Content = TypeFromEntrySchema<typeof schema>
      type Block = Content['blocks'][number]
      type HeroBlock = Extract<Block, { template: 'hero' }>
      type CtaBlock = Extract<Block, { template: 'cta' }>

      // Each variant only has its own template's fields
      expectTypeOf<HeroBlock['value']>().toEqualTypeOf<{ headline: string; body: string }>()
      expectTypeOf<CtaBlock['value']>().toEqualTypeOf<{ title: string; ctaText: string }>()

      // Template narrows to a literal, not a union
      expectTypeOf<HeroBlock['template']>().toEqualTypeOf<'hero'>()

      void schema
    })
  })

  describe('typed reference with resolvedSchema', () => {
    it('infers resolved reference type from resolvedSchema', () => {
      const authorSchema = defineEntrySchema([
        { name: 'name', type: 'string' },
        { name: 'bio', type: 'string' },
      ])

      const postSchema = defineEntrySchema([
        { name: 'title', type: 'string' },
        {
          name: 'author',
          type: 'reference',
          collections: ['authors'],
          resolvedSchema: authorSchema,
        },
      ])

      type PostContent = TypeFromEntrySchema<typeof postSchema>

      expectTypeOf<PostContent['author']>().toEqualTypeOf<{
        name: string
        bio: string
      } | null>()

      void postSchema
    })
  })

  describe('reference without resolvedSchema', () => {
    it('infers string | null for the raw reference ID', () => {
      const schema = defineEntrySchema([
        { name: 'author', type: 'reference', collections: ['authors'] },
      ])

      type Content = TypeFromEntrySchema<typeof schema>

      expectTypeOf<Content['author']>().toEqualTypeOf<string | null>()

      void schema
    })
  })

  describe('nested reference with resolvedSchema', () => {
    it('infers resolved type inside an object field', () => {
      const authorSchema = defineEntrySchema([
        { name: 'name', type: 'string' },
        { name: 'bio', type: 'string' },
      ])

      const schema = defineEntrySchema([
        {
          name: 'meta',
          type: 'object',
          fields: [
            {
              name: 'author',
              type: 'reference',
              collections: ['authors'],
              resolvedSchema: authorSchema,
            },
          ],
        },
      ])

      type Content = TypeFromEntrySchema<typeof schema>

      expectTypeOf<Content['meta']['author']>().toEqualTypeOf<{
        name: string
        bio: string
      } | null>()

      void schema
    })
  })

  describe('typed reference list with resolvedSchema', () => {
    it('infers array of resolved type with null', () => {
      const tagSchema = defineEntrySchema([{ name: 'label', type: 'string' }])

      const schema = defineEntrySchema([
        {
          name: 'tags',
          type: 'reference',
          collections: ['tags'],
          list: true,
          resolvedSchema: tagSchema,
        },
      ])

      type Content = TypeFromEntrySchema<typeof schema>

      expectTypeOf<Content['tags']>().toEqualTypeOf<({ label: string } | null)[]>()

      void schema
    })
  })
})

describe('inline groups', () => {
  it('TypeFromEntrySchema flattens a single inline group — fields appear flat on the type', () => {
    const schema = defineEntrySchema([
      { name: 'title', type: 'string' },
      defineInlineFieldGroup({
        name: 'seo',
        fields: [
          { name: 'metaTitle', type: 'string' },
          { name: 'metaDescription', type: 'string' },
        ],
      }),
    ])

    type Content = TypeFromEntrySchema<typeof schema>

    // All fields are flat on Content — no 'seo' key
    expectTypeOf<Content>().toEqualTypeOf<{
      title: string
      metaTitle: string
      metaDescription: string
    }>()

    void schema
  })

  it('TypeFromEntrySchema flattens nested inline groups — grandchild fields are flat', () => {
    const schema = defineEntrySchema([
      defineInlineFieldGroup({
        name: 'outer',
        fields: [
          { name: 'a', type: 'string' },
          defineInlineFieldGroup({
            name: 'inner',
            fields: [{ name: 'b', type: 'string' }],
          }),
        ],
      }),
    ])

    type Content = TypeFromEntrySchema<typeof schema>

    // Both 'a' and 'b' appear flat — neither 'outer' nor 'inner' key exists
    expectTypeOf<Content>().toEqualTypeOf<{ a: string; b: string }>()

    void schema
  })

  it('TypeFromEntrySchema mixes inline groups and regular fields — all flat', () => {
    const schema = defineEntrySchema([
      { name: 'slug', type: 'string' },
      defineInlineFieldGroup({
        name: 'social',
        fields: [
          { name: 'twitter', type: 'string' },
          { name: 'linkedin', type: 'string' },
        ],
      }),
      { name: 'publishedAt', type: 'date' },
    ])

    type Content = TypeFromEntrySchema<typeof schema>

    expectTypeOf<Content>().toEqualTypeOf<{
      slug: string
      twitter: string
      linkedin: string
      publishedAt: string
    }>()

    void schema
  })

  it('TypeFromEntrySchema with defineNestedFieldGroup — fields appear under the group name', () => {
    const schema = defineEntrySchema([
      { name: 'title', type: 'string' },
      defineNestedFieldGroup({
        name: 'hero',
        fields: [
          { name: 'headline', type: 'string' },
          { name: 'body', type: 'markdown' },
        ],
      }),
    ])

    type Content = TypeFromEntrySchema<typeof schema>

    // 'hero' is a nested object, not flat
    expectTypeOf<Content['hero']>().toEqualTypeOf<{ headline: string; body: string }>()
    expectTypeOf<Content['title']>().toEqualTypeOf<string>()

    void schema
  })

  it('defineInlineFieldGroup injects type: group and returns the config object', () => {
    const fields = [
      { name: 'metaTitle', type: 'string' as const },
      { name: 'metaDescription', type: 'string' as const },
    ] as const

    const group = defineInlineFieldGroup({ name: 'seo', fields })

    expect(group).toEqual({ name: 'seo', type: 'group', fields })
    expect(group.fields).toBe(fields)
  })

  it('defineNestedFieldGroup injects type: object into the returned config', () => {
    const fields = [{ name: 'headline', type: 'string' as const }] as const

    const group = defineNestedFieldGroup({ name: 'hero', fields })

    expect(group).toEqual({ name: 'hero', type: 'object', fields })
    expect(group.type).toBe('object')
    expect(group.fields).toBe(fields)
  })
})
