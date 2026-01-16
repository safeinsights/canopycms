import { describe, expect, it } from 'vitest'

import { generateId, isValidId } from './id'

describe('id utilities', () => {
  describe('generateId', () => {
    it('generates a 12-character string', () => {
      const id = generateId()
      expect(id).toHaveLength(12)
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
    it('returns true for valid 12-character IDs', () => {
      const id = generateId()
      expect(isValidId(id)).toBe(true)
    })

    it('returns true for 12-character IDs', () => {
      expect(isValidId('a1b2c3d4e5f6')).toBe(true)
      expect(isValidId('XYZ123abc789')).toBe(true)
    })

    it('returns true for 22-character legacy IDs', () => {
      expect(isValidId('abc123def456ghi789jkm2')).toBe(true) // 22 chars (legacy)
      expect(isValidId('bChqT78gcaLdXS3kD87oZF')).toBe(true) // Real legacy ID
    })

    it('returns false for IDs with invalid length', () => {
      expect(isValidId('abc123')).toBe(false) // Too short
      expect(isValidId('abc123def456ghi789jkm234567')).toBe(false) // Too long (>22)
    })

    it('returns false for IDs with invalid characters', () => {
      expect(isValidId('abc123!@#$%^')).toBe(false) // Special chars
      expect(isValidId('abc123 space')).toBe(false) // Space
      expect(isValidId('0OIlabc12345')).toBe(false) // Ambiguous chars (0, O, I, l)
    })
  })
})
