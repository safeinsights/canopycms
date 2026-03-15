/**
 * Error handling utilities for type-safe error handling.
 *
 * These utilities help convert `catch (err: unknown)` to usable error information
 * without using `any` types.
 */

/**
 * Extract a message string from an unknown error value.
 *
 * @param err - The caught error (unknown type)
 * @returns A string message suitable for logging or user display
 *
 * @example
 * ```ts
 * try {
 *   await riskyOperation()
 * } catch (err: unknown) {
 *   console.error('Operation failed:', getErrorMessage(err))
 * }
 * ```
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message
  }
  if (typeof err === 'string') {
    return err
  }
  return String(err)
}

/**
 * Type guard to check if an error is a Node.js system error with a code property.
 *
 * @param err - The caught error (unknown type)
 * @returns True if the error has a `code` property (like ENOENT, EACCES, etc.)
 *
 * @example
 * ```ts
 * try {
 *   await fs.readFile(path)
 * } catch (err: unknown) {
 *   if (isNodeError(err) && err.code === 'ENOENT') {
 *     return null // File not found is expected
 *   }
 *   throw err
 * }
 * ```
 */
export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}

/**
 * Check if an error indicates a "file not found" condition.
 *
 * @param err - The caught error (unknown type)
 * @returns True if the error is ENOENT (file/directory not found)
 */
export function isNotFoundError(err: unknown): boolean {
  return isNodeError(err) && err.code === 'ENOENT'
}

/**
 * Check if an error indicates a "permission denied" condition.
 *
 * @param err - The caught error (unknown type)
 * @returns True if the error is EACCES (permission denied)
 */
export function isPermissionError(err: unknown): boolean {
  return isNodeError(err) && err.code === 'EACCES'
}

/**
 * Check if an error indicates a "file already exists" condition.
 *
 * @param err - The caught error (unknown type)
 * @returns True if the error is EEXIST (file already exists)
 */
export function isFileExistsError(err: unknown): boolean {
  return isNodeError(err) && err.code === 'EEXIST'
}
