import { describe, it, expect } from 'vitest'
import { RESOLVE_REFERENCES_ROUTES } from './resolve-references'

const endpoint = RESOLVE_REFERENCES_ROUTES.post

// Valid Base58 content IDs (12 chars, alphabet excludes 0/O/I/l).
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const makeId = (n: number): string =>
  Array.from({ length: 12 }, (_, i) => BASE58[(n + i) % BASE58.length]).join('')

describe('resolveReferences params/body bounds (API-M1)', () => {
  it('accepts an ids array at the maximum allowed size', () => {
    const ids = Array.from({ length: 100 }, (_, i) => makeId(i))
    const result = endpoint.validate({ params: { branch: 'main' }, body: { ids } })
    expect(result.ok).toBe(true)
  })

  it('rejects an ids array over the maximum allowed size', () => {
    const ids = Array.from({ length: 101 }, (_, i) => makeId(i))
    const result = endpoint.validate({ params: { branch: 'main' }, body: { ids } })
    expect(result.ok).toBe(false)
  })

  it('rejects an empty ids array', () => {
    const result = endpoint.validate({ params: { branch: 'main' }, body: { ids: [] } })
    expect(result.ok).toBe(false)
  })
})
