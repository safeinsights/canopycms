import { generate } from 'short-uuid'
import type { ContentId } from './paths/types'
import { isValidContentId } from './paths/validation'

/**
 * Generate a 12-character content ID: a Base58-encoded UUID truncated for
 * shorter filenames. ~58^12 = 2.6 × 10^21 IDs, so 10,000 entries carry a
 * ~0.000000002% collision chance.
 */
export function generateId(): ContentId {
  const full = generate() // 22 chars
  return full.substring(0, 12) as ContentId // Truncate to 12 chars
}

/** Is a string a valid content ID? 12 Base58 characters (no ambiguous 0, O, I, l). */
export const isValidId = isValidContentId
