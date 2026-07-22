import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  formatDirectives,
  isAllowedTransformWidth,
  parseTransformPath,
  IDENTITY_TRANSFORM_DIRECTIVE,
  type TransformDirectives,
} from './transform-directives'

const HASH32 = 'a'.repeat(32)

describe('module purity', () => {
  it('has zero imports - isomorphic/dependency-free by design', () => {
    const filePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'transform-directives.ts',
    )
    const source = readFileSync(filePath, 'utf-8')
    expect(source).not.toMatch(/^\s*import /m)
  })
})

describe('parseTransformPath - happy paths', () => {
  it('parses the identity directive', () => {
    const result = parseTransformPath([IDENTITY_TRANSFORM_DIRECTIVE, HASH32, 'photo.png'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.directives).toEqual({ identity: true })
    expect(result.hash32).toBe(HASH32)
    expect(result.slug).toBe('photo')
    expect(result.ext).toBe('png')
  })

  it('parses a single width directive', () => {
    const result = parseTransformPath(['w=320', HASH32, 'photo.png'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.directives).toEqual({
      identity: false,
      width: 320,
      format: undefined,
      quality: undefined,
      crop: undefined,
    })
  })

  it('parses format + ext matching', () => {
    const result = parseTransformPath(['f=webp', HASH32, 'photo.webp'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.directives.identity).toBe(false)
    if (result.directives.identity) return
    expect(result.directives.format).toBe('webp')
  })

  it('parses quality', () => {
    const result = parseTransformPath(['q=80', HASH32, 'photo.png'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    if (result.directives.identity) return
    expect(result.directives.quality).toBe(80)
  })

  it('parses a crop rect', () => {
    const result = parseTransformPath(['c=0.1:0.2:0.5:0.5', HASH32, 'photo.png'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    if (result.directives.identity) return
    expect(result.directives.crop).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.5 })
  })

  it('parses multiple directives combined, in any input order', () => {
    const result = parseTransformPath(['w=320,f=webp,q=70', HASH32, 'photo.webp'])
    expect(result.ok).toBe(true)
    if (!result.ok || result.directives.identity) return
    expect(result.directives).toMatchObject({ width: 320, format: 'webp', quality: 70 })
  })

  it('accepts a boundary-valid width (160) and (4000, the largest multiple of 160 <= 4096)', () => {
    expect(parseTransformPath(['w=160', HASH32, 'a.png']).ok).toBe(true)
    expect(parseTransformPath(['w=4000', HASH32, 'a.png']).ok).toBe(true)
  })

  it('accepts allowlisted quality boundaries (30 and 95) and rejects everything else', () => {
    expect(parseTransformPath(['q=30', HASH32, 'a.png']).ok).toBe(true)
    expect(parseTransformPath(['q=95', HASH32, 'a.png']).ok).toBe(true)
    // Quality outside the multiples-of-5 [30,95] allowlist is rejected
    // (bounded variant space; see cache-stuffing note in the parser).
    expect(parseTransformPath(['q=1', HASH32, 'a.png']).ok).toBe(false)
    expect(parseTransformPath(['q=25', HASH32, 'a.png']).ok).toBe(false)
    expect(parseTransformPath(['q=72', HASH32, 'a.png']).ok).toBe(false)
    expect(parseTransformPath(['q=100', HASH32, 'a.png']).ok).toBe(false)
  })

  it('accepts a crop touching the full-frame boundary (x+w==1, y+h==1)', () => {
    const result = parseTransformPath(['c=0.5:0.5:0.5:0.5', HASH32, 'a.png'])
    expect(result.ok).toBe(true)
  })

  it('accepts a full-frame crop (0:0:1:1)', () => {
    const result = parseTransformPath(['c=0:0:1:1', HASH32, 'a.png'])
    expect(result.ok).toBe(true)
  })
})

describe('parseTransformPath - canonicalization', () => {
  it('formatDirectives is order-independent: f=webp,w=320 and w=320,f=webp produce identical output', () => {
    const a = parseTransformPath(['f=webp,w=320', HASH32, 'p.webp'])
    const b = parseTransformPath(['w=320,f=webp', HASH32, 'p.webp'])
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(formatDirectives(a.directives)).toBe(formatDirectives(b.directives))
    expect(formatDirectives(a.directives)).toBe('f=webp,w=320')
  })

  it('always orders directives alphabetically: c, f, q, w', () => {
    const result = parseTransformPath(['w=320,q=80,f=png,c=0:0:1:1', HASH32, 'p.png'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(formatDirectives(result.directives)).toBe(
      'c=0.0000:0.0000:1.0000:1.0000,f=png,q=80,w=320',
    )
  })

  it('formats the identity directive as the bare token', () => {
    const result = parseTransformPath([IDENTITY_TRANSFORM_DIRECTIVE, HASH32, 'p.png'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(formatDirectives(result.directives)).toBe(IDENTITY_TRANSFORM_DIRECTIVE)
  })

  it('crop float precision is stable regardless of input formatting (0.1 vs 0.10 vs 0.100)', () => {
    const inputs = ['c=0.1:0.2:0.5:0.5', 'c=0.10:0.20:0.50:0.50', 'c=0.100:0.200:0.500:0.500']
    const formatted = inputs.map((crop) => {
      const result = parseTransformPath([crop, HASH32, 'p.png'])
      if (!result.ok) throw new Error('expected ok')
      return formatDirectives(result.directives)
    })
    expect(new Set(formatted).size).toBe(1)
    expect(formatted[0]).toBe('c=0.1000:0.2000:0.5000:0.5000')
  })

  it('falls back to identity when formatDirectives receives an all-empty ResizeDirectives', () => {
    const empty: TransformDirectives = { identity: false }
    expect(formatDirectives(empty)).toBe(IDENTITY_TRANSFORM_DIRECTIVE)
  })
})

describe('parseTransformPath - rejections', () => {
  it('rejects a width that is not a multiple of 160', () => {
    expect(parseTransformPath(['w=161', HASH32, 'a.png']).ok).toBe(false)
  })

  it('rejects width 0', () => {
    expect(parseTransformPath(['w=0', HASH32, 'a.png']).ok).toBe(false)
  })

  it('rejects a width above the 4096 cap even though it is a "round" number (4160)', () => {
    expect(parseTransformPath(['w=4160', HASH32, 'a.png']).ok).toBe(false)
  })

  it('rejects a width far above the cap', () => {
    expect(parseTransformPath(['w=8320', HASH32, 'a.png']).ok).toBe(false)
  })

  it('rejects a negative or non-numeric width', () => {
    expect(parseTransformPath(['w=-160', HASH32, 'a.png']).ok).toBe(false)
    expect(parseTransformPath(['w=abc', HASH32, 'a.png']).ok).toBe(false)
  })

  it('rejects duplicate keys', () => {
    expect(parseTransformPath(['w=320,w=480', HASH32, 'a.png']).ok).toBe(false)
  })

  it('rejects an unknown key', () => {
    expect(parseTransformPath(['x=1', HASH32, 'a.png']).ok).toBe(false)
  })

  it('rejects an empty directives segment', () => {
    expect(parseTransformPath(['', HASH32, 'a.png']).ok).toBe(false)
  })

  it("rejects 'orig' combined with another directive, in either order", () => {
    expect(parseTransformPath(['orig,w=320', HASH32, 'a.png']).ok).toBe(false)
    expect(parseTransformPath(['w=320,orig', HASH32, 'a.png']).ok).toBe(false)
  })

  it('rejects an ext that does not match an explicit format', () => {
    expect(parseTransformPath(['f=webp', HASH32, 'a.png']).ok).toBe(false)
  })

  it('rejects an unrecognized format value', () => {
    expect(parseTransformPath(['f=avif', HASH32, 'a.avif']).ok).toBe(false)
  })

  it('rejects quality out of range', () => {
    expect(parseTransformPath(['q=0', HASH32, 'a.png']).ok).toBe(false)
    expect(parseTransformPath(['q=101', HASH32, 'a.png']).ok).toBe(false)
  })

  it('rejects a bad hash32 (wrong length / uppercase / non-hex)', () => {
    expect(parseTransformPath(['orig', 'a'.repeat(31), 'a.png']).ok).toBe(false)
    expect(parseTransformPath(['orig', 'A'.repeat(32), 'a.png']).ok).toBe(false)
    expect(parseTransformPath(['orig', 'g'.repeat(32), 'a.png']).ok).toBe(false)
  })

  it('rejects a bad slug charset', () => {
    expect(parseTransformPath(['orig', HASH32, 'Photo File.png']).ok).toBe(false)
  })

  it('rejects a bad ext charset or missing ext', () => {
    expect(parseTransformPath(['orig', HASH32, 'photo.']).ok).toBe(false)
    expect(parseTransformPath(['orig', HASH32, 'photo']).ok).toBe(false)
    expect(parseTransformPath(['orig', HASH32, 'photo.p!g']).ok).toBe(false)
  })

  it('rejects the wrong number of path segments', () => {
    expect(parseTransformPath(['orig', HASH32]).ok).toBe(false)
    expect(parseTransformPath(['orig', HASH32, 'a.png', 'extra']).ok).toBe(false)
  })

  describe('malformed crop', () => {
    it('rejects too few/many parts', () => {
      expect(parseTransformPath(['c=0.1:0.2:0.5', HASH32, 'a.png']).ok).toBe(false)
      expect(parseTransformPath(['c=0.1:0.2:0.5:0.5:0.1', HASH32, 'a.png']).ok).toBe(false)
    })

    it('rejects x+w > 1 or y+h > 1', () => {
      expect(parseTransformPath(['c=0.6:0.1:0.5:0.1', HASH32, 'a.png']).ok).toBe(false)
      expect(parseTransformPath(['c=0.1:0.6:0.1:0.5', HASH32, 'a.png']).ok).toBe(false)
    })

    it('rejects negative components', () => {
      expect(parseTransformPath(['c=-0.1:0.2:0.5:0.5', HASH32, 'a.png']).ok).toBe(false)
    })

    it('rejects zero or negative w/h', () => {
      expect(parseTransformPath(['c=0.1:0.2:0:0.5', HASH32, 'a.png']).ok).toBe(false)
    })

    it('rejects an empty crop value', () => {
      expect(parseTransformPath(['c=', HASH32, 'a.png']).ok).toBe(false)
    })

    it('rejects a component greater than 1', () => {
      expect(parseTransformPath(['c=0.1:0.2:1.5:0.5', HASH32, 'a.png']).ok).toBe(false)
    })
  })
})

describe('isAllowedTransformWidth', () => {
  it('accepts multiples of 160 within [160, 4096]', () => {
    expect(isAllowedTransformWidth(160)).toBe(true)
    expect(isAllowedTransformWidth(320)).toBe(true)
    expect(isAllowedTransformWidth(4000)).toBe(true)
  })

  it('rejects non-multiples, out-of-range, and non-integer values', () => {
    expect(isAllowedTransformWidth(161)).toBe(false)
    expect(isAllowedTransformWidth(0)).toBe(false)
    expect(isAllowedTransformWidth(4160)).toBe(false)
    expect(isAllowedTransformWidth(320.5)).toBe(false)
  })
})
