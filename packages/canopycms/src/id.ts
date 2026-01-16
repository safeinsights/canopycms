import { generate } from 'short-uuid'

/**
 * Generate a new 12-character content ID.
 * Uses Base58-encoded UUID, truncated for shorter filenames.
 *
 * Collision probability with 12 chars:
 * - ~58^12 = 2.6 × 10^21 possible IDs
 * - With 10,000 entries: collision chance ~0.000000002%
 */
export function generateId(): string {
  const full = generate() // 22 chars
  return full.substring(0, 12) // Truncate to 12 chars
}

/**
 * Validate that a string is a valid content ID format.
 * Accepts both 12-character (new format) and 22-character (legacy) IDs.
 * Both use Base58 alphabet (no ambiguous characters: 0, O, I, l).
 */
export function isValidId(id: string): boolean {
  // Accept both 12 chars (new) and 22 chars (legacy from migration)
  return /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{12,22}$/.test(id)
}
