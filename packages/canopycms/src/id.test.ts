import { describe, expect, it } from 'vitest'

import { expandId, generateId, isValidId } from './id'

describe('id utilities', () => {
  describe('generateId', () => {
    it('generates a 22-character string', () => {
      const id = generateId()
      expect(id).toHaveLength(22)
    })

    it('generates unique IDs', () => {
      const id1 = generateId()
      const id2 = generateId()
      expect(id1).not.toBe(id2)
    })

    it('generates URL-safe characters only', () => {
      const id = generateId()
      // Base58 alphabet (no 0, O, I, l to avoid confusion)
      expect(id).toMatch(/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/)
    })
  })

  describe('isValidId', () => {
    it('returns true for valid IDs', () => {
      const id = generateId()
      expect(isValidId(id)).toBe(true)
    })

    it('returns false for clearly invalid IDs', () => {
      expect(isValidId('abc123!@#$%^&*()_+=')).toBe(false)
      expect(isValidId('abc123 space')).toBe(false)
    })
  })

  describe('expandId', () => {
    it('converts short ID to full UUID format', () => {
      const shortId = generateId()
      const fullUuid = expandId(shortId)

      // Full UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      expect(fullUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    })

    it('is reversible with generateId', () => {
      const shortId = generateId()
      const fullUuid = expandId(shortId)

      // Should be a valid UUID
      expect(fullUuid.length).toBe(36)
      expect(fullUuid.split('-').length).toBe(5)
    })

    it('throws for invalid short IDs', () => {
      expect(() => expandId('invalid')).toThrow()
    })
  })
})
