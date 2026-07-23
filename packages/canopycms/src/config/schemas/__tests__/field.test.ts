import { describe, expect, it } from 'vitest'

import { fieldSchema, imageFieldSchema } from '../field'

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
