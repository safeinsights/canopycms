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
