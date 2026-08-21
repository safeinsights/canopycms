import { describe, expect, it, expectTypeOf } from 'vitest'
import {
  defineBlockTemplate,
  defineEntrySchema,
  defineFieldFragment,
  defineInlineFieldGroup,
  defineNestedFieldGroup,
  defineSeoFieldGroup,
  type BlockComponentRegistry,
  type BlockValueOf,
  type EntryTypesFromRegistry,
  type TypeFromEntrySchema,
} from './entry-schema'
import { validateEntryData } from './validation/entry-validator'
import type { EntrySchema, SelectOption } from './config/types'

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

  describe('defineBlockTemplate reuse across schemas', () => {
    it('a shared template reused across two schemas still narrows on .template', () => {
      const heroBlock = defineBlockTemplate({
        name: 'hero',
        label: 'Hero',
        fields: [
          { name: 'headline', type: 'string' },
          { name: 'subheading', type: 'string', required: false },
        ],
      })
      const ctaBlock = defineBlockTemplate({
        name: 'cta',
        fields: [
          { name: 'label', type: 'string' },
          { name: 'href', type: 'string' },
        ],
      })

      const pageSchema = defineEntrySchema([
        { name: 'title', type: 'string' },
        { name: 'sections', type: 'block', templates: [heroBlock, ctaBlock] },
      ])
      // The same templates reused in a second schema
      const landingSchema = defineEntrySchema([
        { name: 'eyebrow', type: 'string' },
        { name: 'blocks', type: 'block', templates: [heroBlock, ctaBlock] },
      ])

      type PageBlock = TypeFromEntrySchema<typeof pageSchema>['sections'][number]
      type LandingBlock = TypeFromEntrySchema<typeof landingSchema>['blocks'][number]

      // Discriminated union narrows per template in both schemas
      expectTypeOf<Extract<PageBlock, { template: 'hero' }>['value']>().toEqualTypeOf<{
        headline: string
        subheading?: string
      }>()
      expectTypeOf<Extract<PageBlock, { template: 'cta' }>['value']>().toEqualTypeOf<{
        label: string
        href: string
      }>()
      expectTypeOf<Extract<LandingBlock, { template: 'hero' }>['value']>().toEqualTypeOf<{
        headline: string
        subheading?: string
      }>()

      // The helper is an identity — it returns the template object unchanged
      expect(heroBlock).toEqual({
        name: 'hero',
        label: 'Hero',
        fields: [
          { name: 'headline', type: 'string' },
          { name: 'subheading', type: 'string', required: false },
        ],
      })

      void pageSchema
      void landingSchema
    })
  })

  describe('BlockComponentRegistry / BlockValueOf', () => {
    const heroBlock = defineBlockTemplate({
      name: 'hero',
      fields: [{ name: 'headline', type: 'string' }],
    })
    const ctaBlock = defineBlockTemplate({
      name: 'cta',
      fields: [{ name: 'label', type: 'string' }],
    })
    const pageSchema = defineEntrySchema([
      { name: 'sections', type: 'block', templates: [heroBlock, ctaBlock] },
    ])
    type Sections = TypeFromEntrySchema<typeof pageSchema>['sections'][number]

    it('BlockValueOf extracts one template value shape out of the union', () => {
      expectTypeOf<BlockValueOf<Sections, 'hero'>>().toEqualTypeOf<{ headline: string }>()
      expectTypeOf<BlockValueOf<Sections, 'cta'>>().toEqualTypeOf<{ label: string }>()
    })

    it('an exhaustive registry (one component per template) compiles', () => {
      // Contextually typed against BlockComponentRegistry<Sections> — `data` in each
      // component is inferred as that template's own value shape, narrowed by key.
      const registry: BlockComponentRegistry<Sections> = {
        hero: ({ data }) => data.headline,
        cta: ({ data }) => data.label,
      }

      expect(Object.keys(registry).sort()).toEqual(['cta', 'hero'])
    })

    it('a registry missing a template key fails to compile', () => {
      // @ts-expect-error - 'cta' is a required key; the registry only has 'hero'
      const missingKey: BlockComponentRegistry<Sections> = {
        hero: ({ data }) => data.headline,
      }

      expect(Object.keys(missingKey)).toEqual(['hero'])
    })

    it('a registry with an unknown extra key fails to compile', () => {
      const withExtra: BlockComponentRegistry<Sections> = {
        hero: ({ data }) => data.headline,
        cta: ({ data }) => data.label,
        // @ts-expect-error - 'unknown' is not a template name on Sections
        unknown: () => null,
      }

      expect(Object.keys(withExtra)).toContain('unknown')
    })

    it('ExtraProps is threaded through every component in the registry', () => {
      type ExtraProps = { index: number }
      const registry: BlockComponentRegistry<Sections, ExtraProps> = {
        hero: ({ data, index }) => `${index}:${data.headline}`,
        cta: ({ data, index }) => `${index}:${data.label}`,
      }

      expect(Object.keys(registry).sort()).toEqual(['cta', 'hero'])
    })

    void pageSchema
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

  describe('image field', () => {
    it('infers the structured ImageFieldValue shape, not a bare string', () => {
      const schema = defineEntrySchema([{ name: 'hero', type: 'image' }])

      type Content = TypeFromEntrySchema<typeof schema>

      expectTypeOf<Content['hero']>().toEqualTypeOf<{
        src: string
        alt: string
        width?: number
        height?: number
        crop?: { x: number; y: number; w: number; h: number }
      }>()

      void schema
    })
  })

  describe('select field', () => {
    it('infers the literal union of its own options, not a bare string', () => {
      const schema = defineEntrySchema([
        { name: 'status', type: 'select', options: ['draft', 'published'] },
      ])

      type Content = TypeFromEntrySchema<typeof schema>

      expectTypeOf<Content['status']>().toEqualTypeOf<'draft' | 'published'>()

      void schema
    })

    it('rejects a string that is not one of the options, and any number', () => {
      const schema = defineEntrySchema([
        { name: 'status', type: 'select', options: ['draft', 'published'] },
      ])

      type Content = TypeFromEntrySchema<typeof schema>

      const valid: Content = { status: 'published' }
      // @ts-expect-error - 'archived' is not one of the declared options
      const notAnOption: Content = { status: 'archived' }
      // @ts-expect-error - no select value can ever be a number: SelectOption carries
      // `value: string` in both arms and validateEntryData rejects a non-string
      const aNumber: Content = { status: 42 }

      expect(valid.status).toBe('published')
      expect(notAnOption.status).toBe('archived')
      expect(aNumber.status).toBe(42)

      void schema
    })

    it('takes `value` off an object option, not the whole option object', () => {
      const schema = defineEntrySchema([
        {
          name: 'status',
          type: 'select',
          options: [
            { label: 'Draft', value: 'draft' },
            { label: 'Published', value: 'published' },
          ],
        },
      ])

      type Content = TypeFromEntrySchema<typeof schema>

      expectTypeOf<Content['status']>().toEqualTypeOf<'draft' | 'published'>()

      const valid: Content = { status: 'draft' }
      // @ts-expect-error - 'Draft' is the option's label, not its value
      const usingLabel: Content = { status: 'Draft' }

      expect(valid.status).toBe('draft')
      expect(usingLabel.status).toBe('Draft')

      void schema
    })

    it('handles an options array mixing bare strings and object options', () => {
      const schema = defineEntrySchema([
        {
          name: 'status',
          type: 'select',
          options: ['draft', { label: 'Published', value: 'published' }, 'archived'],
        },
      ])

      type Content = TypeFromEntrySchema<typeof schema>

      expectTypeOf<Content['status']>().toEqualTypeOf<'draft' | 'published' | 'archived'>()

      // @ts-expect-error - 'Published' is the object option's label, not its value
      const usingLabel: Content = { status: 'Published' }

      expect(usingLabel.status).toBe('Published')

      void schema
    })

    it('a list select becomes an array of the option union', () => {
      const schema = defineEntrySchema([
        { name: 'tags', type: 'select', list: true, options: ['a', 'b'] },
      ])

      type Content = TypeFromEntrySchema<typeof schema>

      expectTypeOf<Content['tags']>().toEqualTypeOf<Array<'a' | 'b'>>()

      // @ts-expect-error - 'c' is not one of the declared options
      const wrong: Content = { tags: ['a', 'c'] }

      expect(wrong.tags).toEqual(['a', 'c'])

      void schema
    })

    it('the inferred union agrees with what validateEntryData accepts at runtime', () => {
      const schema = defineEntrySchema([
        { name: 'status', type: 'select', options: ['draft', { label: 'Live', value: 'live' }] },
      ])

      type Content = TypeFromEntrySchema<typeof schema>

      const live: Content = { status: 'live' }

      expect(validateEntryData(schema as EntrySchema, live)).toEqual([])
      expect(validateEntryData(schema as EntrySchema, { status: 'Live' })).toEqual([
        { fieldPath: 'status', message: 'Must be one of: draft, live' },
      ])
      expect(validateEntryData(schema as EntrySchema, { status: 42 })).toEqual([
        { fieldPath: 'status', message: 'Expected a selection' },
      ])
    })

    it('degrades to string when there is no literal option list to infer', () => {
      // No `options` key at all, and an empty one — both are schema mistakes that
      // validateCanopyConfig rejects at runtime. Neither should type as `never`.
      const noOptions = defineEntrySchema([{ name: 'status', type: 'select' }])
      const emptyOptions = defineEntrySchema([{ name: 'status', type: 'select', options: [] }])

      expectTypeOf<TypeFromEntrySchema<typeof noOptions>['status']>().toEqualTypeOf<string>()
      expectTypeOf<TypeFromEntrySchema<typeof emptyOptions>['status']>().toEqualTypeOf<string>()

      // An options array annotated as the runtime SelectOption[] has no literals left,
      // so it widens to `string` rather than failing to compile.
      const options: SelectOption[] = ['draft', { label: 'Live', value: 'live' }]
      const widened = defineEntrySchema([{ name: 'status', type: 'select', options }])

      expectTypeOf<TypeFromEntrySchema<typeof widened>['status']>().toEqualTypeOf<string>()

      void noOptions
      void emptyOptions
      void widened
    })
  })

  describe('required-ness to property optionality', () => {
    // Three-way distinction, deliberately: ONLY an explicit `required: false` produces
    // an optional (`?:`) property. `required: true` and an OMITTED `required` both
    // produce a plain required property, because an omitted `required` infers
    // `boolean | undefined`, which does not extend `false`. Widening the omitted case
    // into optional would break every schema that relies on the default — this test
    // exists so that can never happen silently.
    const schema = defineEntrySchema([
      { name: 'explicitlyRequired', type: 'string', required: true },
      { name: 'explicitlyOptional', type: 'string', required: false },
      { name: 'requiredOmitted', type: 'string' },
    ])

    type Content = TypeFromEntrySchema<typeof schema>

    it('maps required: true, required: false, and an omitted required distinctly', () => {
      expectTypeOf<Content>().toEqualTypeOf<{
        explicitlyRequired: string
        requiredOmitted: string
        explicitlyOptional?: string
      }>()

      // Genuinely optional, NOT required-with-undefined (the pre-0.0.63 shape).
      expectTypeOf<Content>().not.toEqualTypeOf<{
        explicitlyRequired: string
        requiredOmitted: string
        explicitlyOptional: string | undefined
      }>()

      // Reading is unchanged: the optional key still reads as `string | undefined`.
      expectTypeOf<Content['explicitlyOptional']>().toEqualTypeOf<string | undefined>()

      expect(schema).toHaveLength(3)
    })

    it('a literal may omit the required: false field, but not the other two', () => {
      const complete: Content = {
        explicitlyRequired: 'a',
        requiredOmitted: 'b',
        explicitlyOptional: 'c',
      }
      const omittingOptional: Content = { explicitlyRequired: 'a', requiredOmitted: 'b' }

      // @ts-expect-error - a field that omits `required` stays a required property
      const missingOmitted: Content = { explicitlyRequired: 'a', explicitlyOptional: 'c' }
      // @ts-expect-error - `required: true` stays a required property
      const missingRequired: Content = { requiredOmitted: 'b' }

      expect(complete.explicitlyOptional).toBe('c')
      expect(omittingOptional.explicitlyOptional).toBeUndefined()
      expect(missingOmitted.explicitlyRequired).toBe('a')
      expect(missingRequired.requiredOmitted).toBe('b')
    })

    it('applies the same rule inside nested objects and block templates', () => {
      const nestedSchema = defineEntrySchema([
        {
          name: 'meta',
          type: 'object',
          fields: [
            { name: 'kicker', type: 'string' },
            { name: 'note', type: 'string', required: false },
          ],
        },
        {
          name: 'sections',
          type: 'block',
          templates: [
            {
              name: 'hero',
              fields: [
                { name: 'heading', type: 'string' },
                { name: 'sub', type: 'string', required: false },
              ],
            },
          ],
        },
      ])

      type Nested = TypeFromEntrySchema<typeof nestedSchema>

      expectTypeOf<Nested['meta']>().toEqualTypeOf<{ kicker: string; note?: string }>()
      expectTypeOf<Nested['sections'][number]['value']>().toEqualTypeOf<{
        heading: string
        sub?: string
      }>()

      expect(nestedSchema).toHaveLength(2)
    })

    it('a whole field marked required: false becomes an optional key at the top level', () => {
      const optionalContainers = defineEntrySchema([
        { name: 'tags', type: 'string', list: true, required: false },
        {
          name: 'seo',
          type: 'object',
          required: false,
          fields: [{ name: 'metaTitle', type: 'string' }],
        },
      ])

      type Optional = TypeFromEntrySchema<typeof optionalContainers>

      expectTypeOf<Optional>().toEqualTypeOf<{
        tags?: string[]
        seo?: { metaTitle: string }
      }>()

      // An empty literal satisfies a schema whose every field is `required: false`.
      const empty: Optional = {}
      expect(empty).toEqual({})
      expect(optionalContainers.map((f) => f.required)).toEqual([false, false])
    })
  })
})

describe('defineSeoFieldGroup', () => {
  // The recommended group is FLAT by default, so the SEO fields must land at the top level of
  // the derived shape — the same convention extractSeoFields reads without configuration.
  it('flattens into the parent shape, with every field optional', () => {
    const schema = defineEntrySchema([{ name: 'title', type: 'string' }, defineSeoFieldGroup()])

    type Content = TypeFromEntrySchema<typeof schema>

    expectTypeOf<Content>().toEqualTypeOf<{
      title: string
      metaTitle?: string
      metaDescription?: string
      ogImage?: string
      // The two select fields narrow to their own declared options, not a bare string.
      ogType?: 'website' | 'article' | 'profile'
      canonical?: string
      noindex?: boolean
      twitterCard?: 'summary' | 'summary_large_image'
    }>()

    // An entry that sets no SEO fields at all is still a valid literal.
    const bare: Content = { title: 'Hello' }
    expect(bare.metaTitle).toBeUndefined()
    // The group is one entry in the schema array; the flattening is purely type-level.
    expect(schema).toHaveLength(2)
  })

  it('nests under the given key when `group` is passed, with the wrapper key itself optional', () => {
    const schema = defineEntrySchema([
      { name: 'title', type: 'string' },
      defineSeoFieldGroup({ group: 'seo' }),
    ])

    type Content = TypeFromEntrySchema<typeof schema>

    expectTypeOf<Content['title']>().toEqualTypeOf<string>()
    // Regression test: the `seo` wrapper key itself must type as optional, matching the runtime
    // validator (validateEntryData only enforces fields with `required: true`) — an earlier
    // version typed the wrapper as required while the runtime treated it as optional, so
    // type-safe `data.seo.metaTitle` access could crash on real content with no `seo:` key.
    expectTypeOf<Content>().toEqualTypeOf<{
      title: string
      seo?: {
        metaTitle?: string
        metaDescription?: string
        ogImage?: string
        ogType?: 'website' | 'article' | 'profile'
        canonical?: string
        noindex?: boolean
        twitterCard?: 'summary' | 'summary_large_image'
      }
    }>()
    expect(schema[1]).toMatchObject({ name: 'seo', type: 'object', required: false })

    // An entry that omits `seo:` entirely is both a valid literal and passes validation.
    const bare: Content = { title: 'Hello' }
    expect(bare.seo).toBeUndefined()
    expect(validateEntryData(schema as EntrySchema, bare)).toEqual([])
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

describe('defineFieldFragment', () => {
  it('is an identity helper — returns the same field array, literal types intact', () => {
    const ctaFields = defineFieldFragment([
      { name: 'ctaLabel', type: 'string' },
      { name: 'ctaHref', type: 'string' },
    ])

    expect(ctaFields).toEqual([
      { name: 'ctaLabel', type: 'string' },
      { name: 'ctaHref', type: 'string' },
    ])
  })

  it('spreads into multiple schemas, preserving literal field names', () => {
    const ctaLabelField = { name: 'ctaLabel', type: 'string' } as const
    const ctaHrefField = { name: 'ctaHref', type: 'string', required: false } as const
    const ctaFields = defineFieldFragment([ctaLabelField, ctaHrefField])

    const heroSchema = defineEntrySchema([{ name: 'headline', type: 'string' }, ...ctaFields])
    // Per-use override: this schema needs ctaHref required, unlike the shared fragment —
    // compose from the same underlying field const, overriding just `required`.
    const bannerSchema = defineEntrySchema([
      { name: 'message', type: 'string' },
      ctaLabelField,
      { ...ctaHrefField, required: true },
    ])

    type Hero = TypeFromEntrySchema<typeof heroSchema>
    type Banner = TypeFromEntrySchema<typeof bannerSchema>

    expectTypeOf<Hero>().toEqualTypeOf<{
      headline: string
      ctaLabel: string
      ctaHref?: string
    }>()
    expectTypeOf<Banner>().toEqualTypeOf<{
      message: string
      ctaLabel: string
      ctaHref: string
    }>()

    void heroSchema
    void bannerSchema
  })
})

describe('EntryTypesFromRegistry', () => {
  // These tests are primarily compile-time assertions — the runtime body just
  // confirms the helper exists. If the type derivation breaks, tsc will fail.

  it('derives entry-type-keyed map from a registry value', () => {
    const partnerSchema = defineEntrySchema([
      { name: 'name', type: 'string', isTitle: true },
      { name: 'isFictional', type: 'boolean' },
    ])
    const docSchema = defineEntrySchema([{ name: 'title', type: 'string' }])

    const registry = {
      partner: partnerSchema,
      doc: docSchema,
    } as const

    type EntryTypes = EntryTypesFromRegistry<typeof registry>

    expect(Object.keys(registry).sort()).toEqual(['doc', 'partner'])

    // Discriminated keys
    expectTypeOf<keyof EntryTypes>().toEqualTypeOf<'partner' | 'doc'>()

    // partner shape carries the schema-derived fields
    expectTypeOf<EntryTypes['partner']>().toMatchTypeOf<{
      name: string
      isFictional: boolean
    }>()

    // doc shape carries its own (disjoint) fields
    expectTypeOf<EntryTypes['doc']>().toMatchTypeOf<{ title: string }>()

    // partner does NOT carry doc's fields and vice versa — per-entry-type isolation
    type PartnerKeys = keyof EntryTypes['partner']
    type DocKeys = keyof EntryTypes['doc']
    expectTypeOf<PartnerKeys & 'title'>().toEqualTypeOf<never>()
    expectTypeOf<DocKeys & 'name'>().toEqualTypeOf<never>()

    expect(true).toBe(true)
  })

  it('per-schema aliases derive from EntryTypes[K]', () => {
    const partnerSchema = defineEntrySchema([
      { name: 'name', type: 'string', isTitle: true },
      { name: 'tagline', type: 'string' },
    ])

    const registry = { partner: partnerSchema } as const
    expect(Object.keys(registry)).toEqual(['partner'])
    type EntryTypes = EntryTypesFromRegistry<typeof registry>
    type PartnerContent = EntryTypes['partner']

    // PartnerContent equals what TypeFromEntrySchema would produce on its own
    expectTypeOf<PartnerContent>().toEqualTypeOf<TypeFromEntrySchema<typeof partnerSchema>>()

    expect(true).toBe(true)
  })
})
