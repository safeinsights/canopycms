import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { assetSrc } from './asset-src'

const HASH32 = 'a'.repeat(32)

describe('module purity', () => {
  it('imports nothing beyond asset-prefixes.ts/transform-directives.ts/types.ts (no node:crypto/sharp reachable from here)', () => {
    // Regression: this file used to import ASSET_PREFIXES from './keys',
    // which pulls in `node:crypto` (used by keys.ts's `hashBytes`) at module
    // scope - defeating the whole point of the client/server split (see
    // asset-prefixes.ts's doc comment). Mirrors asset-url.test.ts's own
    // purity test, extended to allow `./types` (type-only, zero runtime
    // imports of its own - see types.ts's doc comment) since asset-src.ts
    // imports `AssetMeta` as a type.
    const filePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'asset-src.ts')
    const source = readFileSync(filePath, 'utf-8')
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(specifier).toMatch(/^\.\/(asset-prefixes|transform-directives|types)$/)
    }
  })
})

describe('assetSrc', () => {
  it('builds a static public src for svg', () => {
    const src = assetSrc({ hash32: HASH32, slug: 'logo', ext: 'svg', kind: 'svg' })
    expect(src).toBe(`/assets/${HASH32}/logo.svg`)
  })

  it('builds a static public src for pdf', () => {
    const src = assetSrc({ hash32: HASH32, slug: 'doc', ext: 'pdf', kind: 'pdf' })
    expect(src).toBe(`/assets/${HASH32}/doc.pdf`)
  })

  it('builds an identity transform src for raster', () => {
    const src = assetSrc({ hash32: HASH32, slug: 'photo', ext: 'png', kind: 'raster' })
    expect(src).toBe(`/assets/t/orig/${HASH32}/photo.png`)
  })
})
