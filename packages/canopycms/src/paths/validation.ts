/** Security-focused validation for content paths, IDs, branch names and slugs. */

import { normalizeFilesystemPath, hasTraversalSequence } from './normalize'
import type { LogicalPath, PhysicalPath, ContentId, BranchName, Slug } from './types'

/** Base58 alphabet for content IDs: excludes the ambiguous 0, O, I and l. */
const BASE58_PATTERN = '[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]'

const CONTENT_ID_PATTERN = new RegExp(`^${BASE58_PATTERN}{12}$`)

/**
 * A physical path segment carries an embedded ID: `posts.abc123def456` for a
 * collection directory, `post.my-slug.abc123def456.json` for an entry file.
 */
const PHYSICAL_SEGMENT_PATTERN = new RegExp(`\\.${BASE58_PATTERN}{12}(?:\\.[a-z]+)?$`)

/**
 * Reject a content path that traverses, or that escapes `rootPath`.
 * @internal Exported for tests.
 */
export function validateContentPath(
  path: string,
  rootPath: string,
): { valid: boolean; error?: string } {
  const normalized = normalizeFilesystemPath(path)

  if (hasTraversalSequence(normalized)) {
    return { valid: false, error: 'Path contains traversal sequence' }
  }

  const normalizedRoot = normalizeFilesystemPath(rootPath)
  if (!normalized.startsWith(normalizedRoot) && normalized !== normalizedRoot) {
    // Not already rooted: re-check as a path relative to the root.
    const normalizedPath = `${normalizedRoot}/${normalized}`
    if (hasTraversalSequence(normalizedPath)) {
      return { valid: false, error: 'Path escapes root directory' }
    }
  }

  return { valid: true }
}

/**
 * A collection path must be non-empty, traversal-free, and `[A-Za-z0-9_/-]+`.
 * @internal Exported for tests.
 */
export function isValidCollectionPath(collectionPath: string): boolean {
  if (!collectionPath || collectionPath.length === 0) {
    return false
  }

  const normalized = normalizeFilesystemPath(collectionPath)
  if (hasTraversalSequence(normalized)) {
    return false
  }

  const validPattern = /^[a-zA-Z0-9_/-]+$/
  return validPattern.test(normalized)
}

/**
 * Strip the characters that make a string unsafe as a path component.
 * @internal Exported for tests.
 */
export function sanitizeForPath(input: string): string {
  return input
    .replace(/[<>:"|?*\\]/g, '') // Remove invalid filesystem chars
    .replace(/\.{2,}/g, '.') // Collapse multiple dots
    .replace(/^\./, '') // Remove leading dot
    .trim()
}

/**
 * Whether a single path segment (no slashes) carries an embedded content ID.
 * @internal Exported for tests.
 */
export function hasEmbeddedContentId(segment: string): boolean {
  return PHYSICAL_SEGMENT_PATTERN.test(segment)
}

/**
 * Whether any segment carries an embedded content ID:
 * `content/posts.abc123/post.hello.def456.json` does, `content/posts/hello`
 * does not.
 * @internal Exported for tests.
 */
export function looksLikePhysicalPath(path: string): boolean {
  const segments = path.split('/')
  return segments.some(hasEmbeddedContentId)
}

/** @internal Exported for tests. */
export function looksLikeLogicalPath(path: string): boolean {
  return !looksLikePhysicalPath(path)
}

/**
 * Validate an incoming path string at an API boundary and cast it to the
 * branded LogicalPath type.
 */
export function parseLogicalPath(
  path: string,
): { ok: true; path: LogicalPath } | { ok: false; error: string } {
  if (!path || typeof path !== 'string') {
    return { ok: false, error: 'Path is required' }
  }

  // One separator in the branded value, as in parsePermissionPath.
  const normalized = path.replace(/\\/g, '/')

  if (hasTraversalSequence(normalized)) {
    return { ok: false, error: 'Path contains traversal sequence' }
  }

  if (looksLikePhysicalPath(normalized)) {
    return {
      ok: false,
      error:
        'Path appears to be a physical path (contains embedded content ID). Expected a logical path.',
    }
  }

  return { ok: true, path: normalized as LogicalPath }
}

/**
 * Validate an incoming path string at an API boundary and cast it to the
 * branded PhysicalPath type.
 * @internal Exported for tests.
 */
export function parsePhysicalPath(
  path: string,
): { ok: true; path: PhysicalPath } | { ok: false; error: string } {
  if (!path || typeof path !== 'string') {
    return { ok: false, error: 'Path is required' }
  }

  // One separator in the branded value, as in parseLogicalPath.
  const normalized = path.replace(/\\/g, '/')

  if (hasTraversalSequence(normalized)) {
    return { ok: false, error: 'Path contains traversal sequence' }
  }

  if (!looksLikePhysicalPath(normalized)) {
    return {
      ok: false,
      error:
        'Path appears to be a logical path (no embedded content ID). Expected a physical path.',
    }
  }

  return { ok: true, path: normalized as PhysicalPath }
}

export function isValidContentId(id: string): boolean {
  return CONTENT_ID_PATTERN.test(id)
}

/** Validate a string as a 12-character Base58 ContentId and cast it. */
export function parseContentId(
  id: string,
): { ok: true; id: ContentId } | { ok: false; error: string } {
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'Content ID is required' }
  }

  if (!isValidContentId(id)) {
    return {
      ok: false,
      error: `Invalid content ID format (expected 12 Base58 characters, got: ${id})`,
    }
  }

  return { ok: true, id: id as ContentId }
}

/** Validate a branch name against git's ref rules and cast it to BranchName. */
export function parseBranchName(
  name: string,
): { ok: true; name: BranchName } | { ok: false; error: string } {
  if (!name || typeof name !== 'string') {
    return { ok: false, error: 'Branch name is required' }
  }

  // Length limit (branch names become directory names)
  if (name.length > 250) {
    return { ok: false, error: 'Branch name too long (max 250 characters)' }
  }

  if (name.includes('..')) {
    return { ok: false, error: 'Branch name cannot contain ".."' }
  }

  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    return { ok: false, error: 'Invalid branch name format (invalid slashes)' }
  }

  if (name.includes(' ')) {
    return { ok: false, error: 'Branch name cannot contain spaces' }
  }

  // Reject a leading hyphen: validated names flow positionally into git
  // commands (e.g. `git checkout <branch>`), and a name like "--upload-pack=x"
  // would otherwise be parsed by git as an option rather than a ref name.
  if (name.startsWith('-')) {
    return { ok: false, error: 'Branch name cannot start with "-"' }
  }

  if (name.startsWith('.') || name.endsWith('.')) {
    return { ok: false, error: 'Branch name cannot start or end with a dot' }
  }

  if (name.includes('@{')) {
    return { ok: false, error: 'Branch name cannot contain "@{"' }
  }

  // Bare "HEAD" and "@" are ambiguous shorthand for the current ref, not real
  // branch names. Names merely containing them ("release-HEAD") stay legal.
  if (name === 'HEAD' || name === '@') {
    return { ok: false, error: 'Branch name cannot be the reserved ref "HEAD" or "@"' }
  }

  // Git-forbidden characters: ~ ^ : ? * [ \ and control chars
  // eslint-disable-next-line no-control-regex -- intentional: git forbids control characters in branch names
  if (/[~^:?*[\\\x00-\x1f\x7f]/.test(name)) {
    return { ok: false, error: 'Branch name contains invalid characters' }
  }

  if (name.endsWith('.lock')) {
    return { ok: false, error: 'Branch name cannot end with ".lock"' }
  }

  return { ok: true, name: name as BranchName }
}

/** Validate a collection or entry slug and cast it to Slug. */
export function parseSlug(slug: string): { ok: true; slug: Slug } | { ok: false; error: string } {
  if (!slug) {
    return {
      ok: false,
      error: 'Slug is required',
    }
  }

  // Check length (filesystem path safety)
  if (slug.length > 64) {
    return { ok: false, error: 'Slug too long (max 64 characters)' }
  }

  if (slug.includes('/') || slug.includes('\\')) {
    return {
      ok: false,
      error: 'Slug cannot contain path separators',
    }
  }

  if (slug === '.' || slug === '..') {
    return {
      ok: false,
      error: 'Slug cannot be a traversal sequence',
    }
  }

  // Normalize to lowercase for case-insensitive matching
  const normalized = slug.toLowerCase()

  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) {
    return {
      ok: false,
      error:
        'Slug must start with a letter or number and contain only lowercase letters, numbers, and hyphens',
    }
  }

  return { ok: true, slug: normalized as Slug }
}
