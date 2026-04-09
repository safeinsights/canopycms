import { describe, it, expectTypeOf } from 'vitest'
import { defineEntrySchema, type TypeFromEntrySchema } from './entry-schema'

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
