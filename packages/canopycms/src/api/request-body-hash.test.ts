import { describe, it, expect } from 'vitest'
import { computeContentSha256Hex, computeContentSha256HexFromBytes } from './request-body-hash'

describe('computeContentSha256Hex', () => {
  it('hashes the empty string to the known SHA-256 vector', async () => {
    const hash = await computeContentSha256Hex('')
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('hashes a JSON payload deterministically to lowercase hex', async () => {
    const body = JSON.stringify({ branch: 'test-branch' })
    const hash = await computeContentSha256Hex(body)

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    // Re-hashing the same input must be deterministic.
    await expect(computeContentSha256Hex(body)).resolves.toBe(hash)
  })

  it('returns undefined when WebCrypto is unavailable', async () => {
    const originalCrypto = globalThis.crypto
    // Simulate a non-secure context (e.g. dev server over plain http) where
    // crypto.subtle is not exposed.
    Object.defineProperty(globalThis, 'crypto', {
      value: {},
      configurable: true,
    })

    try {
      const hash = await computeContentSha256Hex('some body')
      expect(hash).toBeUndefined()
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        configurable: true,
      })
    }
  })
})

describe('computeContentSha256HexFromBytes', () => {
  it('hashes raw bytes to the same value as the equivalent string', async () => {
    const text = 'hello world'
    const bytes = new TextEncoder().encode(text)

    const fromBytes = await computeContentSha256HexFromBytes(bytes)
    const fromString = await computeContentSha256Hex(text)

    expect(fromBytes).toBe(fromString)
  })
})
