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
 * Standard format: 12 characters using Base58 alphabet (no ambiguous characters: 0, O, I, l).
 */
export function isValidId(id: string): boolean {
  // Only accept 12-char IDs (legacy 22-char support removed)
  return /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{12}$/.test(id)
}
