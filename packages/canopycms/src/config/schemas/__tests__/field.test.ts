import { describe, expect, it } from 'vitest'

import { fieldSchema, imageFieldSchema, referenceFieldSchema } from '../field'

describe('imageFieldSchema', () => {
  it('accepts a minimal image field', () => {
    expect(() => imageFieldSchema.parse({ name: 'hero', type: 'image' })).not.toThrow()
  })

  it('accepts altOptional: true', () => {
    const parsed = imageFieldSchema.parse({ name: 'hero', type: 'image', altOptional: true })
    expect(parsed.altOptional).toBe(true)
  })

  describe('aspect ratio format', () => {
    it.each(['16:9', '1:1', '4:3', '21:9'])('accepts "%s"', (aspect) => {
      expect(() => imageFieldSchema.parse({ name: 'hero', type: 'image', aspect })).not.toThrow()
    })

    it.each(['0:1', '1:0', '16:', ':9', 'a:b', '16-9', '16:9:1', '', ' 16:9', '16:9 '])(
      'rejects "%s"',
      (aspect) => {
        expect(() => imageFieldSchema.parse({ name: 'hero', type: 'image', aspect })).toThrow()
      },
    )
  })

  it('is reachable through the general fieldSchema union', () => {
    const parsed = fieldSchema.parse({ name: 'hero', type: 'image', aspect: '16:9' })
    expect(parsed).toMatchObject({ name: 'hero', type: 'image', aspect: '16:9' })
  })
})

describe('referenceFieldSchema', () => {
  // zod strips unknown keys by default, so a runtime-consumed flag that is missing here is
  // deleted silently by any consumer that adopts the parse output -- the feature no-ops with
  // no error at all. Every key resolution actually reads must therefore be declared.
  it.each(['displayField', 'includeBody', 'entryTypes', 'collections'] as const)(
    'preserves the runtime-consumed key %s',
    (key) => {
      const input: Record<string, unknown> = {
        name: 'snippet',
        type: 'reference',
        entryTypes: ['ctaSnippet'],
        collections: ['content/snippets'],
        displayField: 'title',
        includeBody: true,
      }
      const parsed = referenceFieldSchema.parse(input) as Record<string, unknown>
      expect(parsed[key]).toEqual(input[key])
    },
  )

  it('survives the general fieldSchema union with includeBody intact', () => {
    const parsed = fieldSchema.parse({
      name: 'snippet',
      type: 'reference',
      entryTypes: ['ctaSnippet'],
      includeBody: true,
    })
    expect(parsed).toMatchObject({ name: 'snippet', type: 'reference', includeBody: true })
  })

  it('rejects a non-boolean includeBody', () => {
    expect(() =>
      referenceFieldSchema.parse({
        name: 'snippet',
        type: 'reference',
        entryTypes: ['ctaSnippet'],
        includeBody: 'yes',
      }),
    ).toThrow()
  })
})

describe('markdown field options: renderAs and mdxAllow', () => {
  const narrow = {
    components: { Callout: { props: { type: ['info', 'warning'] } } },
    htmlTags: [],
    expressions: false,
    fragments: false,
  }
  const parse = (field: Record<string, unknown>) => fieldSchema.safeParse(field)
  const messageOf = (field: Record<string, unknown>) => {
    const result = parse(field)
    return result.success ? undefined : result.error.issues.map((i) => i.message).join('; ')
  }

  it('keeps renderAs and mdxAllow through a parse', () => {
    const field = { name: 'body', type: 'markdown', renderAs: 'mdx', mdxAllow: narrow }
    expect(fieldSchema.parse(field)).toEqual(field)
    expect(
      fieldSchema.parse({ name: 'body', type: 'mdx', mdxAllow: { htmlTags: ['div'] } }),
    ).toEqual({ name: 'body', type: 'mdx', mdxAllow: { htmlTags: ['div'] } })
  })

  it('refuses options that contradict each other', () => {
    expect(messageOf({ name: 'b', type: 'mdx', renderAs: 'mdx' })).toMatch(
      /renderAs applies to markdown/,
    )
    expect(messageOf({ name: 'b', type: 'markdown', mdxAllow: {} })).toMatch(/set renderAs: 'mdx'/)
    expect(messageOf({ name: 'b', type: 'mdx', executable: true, mdxAllow: {} })).toMatch(
      /executable: true/,
    )
    expect(messageOf({ name: 'b', type: 'markdown', renderAs: 'markdown' })).toBeDefined()
  })

  it.each([
    ['an unsafe tag', { htmlTags: ['script'] }, /HTML tags the base MDX policy accepts/],
    ['an upper-case tag', { htmlTags: ['DIV'] }, /HTML tags the base MDX policy accepts/],
    ['a lower-case component', { components: { callout: {} } }, /component name/],
    ['a member-expression component', { components: { 'motion.div': {} } }, /component name/],
    ['an MDX binding', { components: { MDXContent: {} } }, /component name/],
    ['a handler prop', { components: { Button: { props: { onClick: true } } } }, /always refused/],
    ['a srcdoc prop', { components: { Frame: { props: { srcDoc: true } } } }, /always refused/],
    ['an empty value list', { components: { Callout: { props: { type: [] } } } }, /at least 1/],
    ['a false prop rule', { components: { Callout: { props: { type: false } } } }, /./],
    ['a misspelt key', { htmltags: [] }, /Unrecognized key/],
    ['a misspelt component key', { components: { Callout: { prop: {} } } }, /Unrecognized key/],
  ])('refuses %s in mdxAllow', (_label, mdxAllow, message) => {
    expect(messageOf({ name: 'b', type: 'mdx', mdxAllow })).toMatch(message)
  })
})
