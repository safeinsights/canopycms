import { generate, createTranslator } from 'short-uuid'

const translator = createTranslator()

/**
 * Generate a new globally unique content ID.
 * Returns a 22-character URL-safe string (Base58 encoded UUID).
 */
export function generateId(): string {
  return generate()
}

/**
 * Validate that a string is a valid content ID format.
 */
export function isValidId(id: string): boolean {
  try {
    translator.toUUID(id) // Throws if invalid
    return true
  } catch {
    return false
  }
}

/**
 * Expand a short ID to its full UUID format if needed.
 */
export function expandId(shortId: string): string {
  return translator.toUUID(shortId)
}
