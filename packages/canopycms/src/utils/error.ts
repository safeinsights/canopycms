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
 * Redact sensitive material from an error message before sending it to API
 * clients. Log the ORIGINAL message server-side; send the sanitized one.
 *
 * Git/filesystem errors are unbounded (stderr varies by git version, locale,
 * and hooks can print anything), so enumerating safe messages is not
 * feasible. Instead, redact the known-sensitive SHAPES that can appear in
 * any of them:
 * - credentials embedded in URLs (`https://x-access-token:tok@github.com/…`)
 * - absolute filesystem paths (workspace roots, EFS mounts, home directories)
 *
 * Paths under the current working directory are shortened to relative form
 * (CMS-internal layout like `.canopy-dev/remote.git` is useful for debugging
 * and not sensitive); absolute paths outside it are replaced with `<path>`.
 */
export function sanitizeErrorMessage(message: string): string {
  let result = message
  // Credentials in URLs: scheme://user:token@host or scheme://token@host.
  // Anchored on the literal `://` (leaving the scheme untouched) — a `\w+`
  // scheme prefix would backtrack polynomially on long word-character runs
  // (CodeQL js/polynomial-redos).
  result = result.replace(/(:\/\/)[^/\s@]+@/g, '$1***@')
  // Paths under the project root become relative (split/join avoids regex
  // escaping issues with arbitrary cwd values). The bare-cwd replacement is
  // anchored to a token boundary so sibling directories that merely share
  // the cwd prefix (e.g. `${cwd}-other/…`) stay absolute and get fully
  // redacted below instead of leaking a mangled remainder.
  const cwd = process.cwd()
  if (cwd !== '/') {
    result = result.split(`${cwd}/`).join('')
    const cwdPattern = cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // cwdPattern is process.cwd() (server-controlled, not attacker/entry-content
    // data) with regex metacharacters escaped by the literal regex above, so
    // this cannot be used to inject an attacker-chosen pattern.
    // eslint-disable-next-line security/detect-non-literal-regexp
    result = result.replace(new RegExp(`${cwdPattern}(?=[\\s'"),:;]|$)`, 'g'), '.')
  }
  // Quoted absolute paths (git quotes most paths in its messages): redact
  // the whole quoted span, spaces included.
  result = result.replace(/'\/[^']*'/g, "'<path>'").replace(/"\/[^"]*"/g, '"<path>"')
  // Remaining absolute POSIX paths (outside cwd, e.g. /mnt/efs/…). The
  // leading boundary keeps URL slashes (`https://host/…`) untouched. Known
  // limitation: an UNQUOTED path containing spaces is only redacted up to
  // the first space — spaces are legal both inside paths and as message
  // separators, so this is not generally solvable here.
  //
  // The repeated group `(?:[^/\s'")]+\/)+` looks nested-quantifier-shaped, but
  // the inner character class excludes `/`, so each repetition can only end at
  // a literal `/` boundary in the input: there is exactly one way to decompose
  // any matched string into repetitions (no same-substring ambiguity), so this
  // does not backtrack catastrophically. Verified empirically with inputs up
  // to 400k chars (adversarial runs of non-slash chars, with and without
  // trailing slashes): scaling stayed linear, not quadratic/exponential.
  // eslint-disable-next-line security/detect-unsafe-regex
  result = result.replace(/(^|[\s'"(=])\/(?:[^/\s'")]+\/)+[^/\s'")]*/g, '$1<path>')
  // Windows drive paths
  result = result.replace(/[A-Za-z]:\\[^\s'")]+/g, '<path>')
  return result
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
