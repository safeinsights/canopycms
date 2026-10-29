/** Security-focused validation for content paths, IDs, branch names and slugs. */

import { sanitizeBranchName } from './branch-name'
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

/** The longest branch name taken, in characters: names become directory names. */
const MAX_BRANCH_NAME_LENGTH = 250

/**
 * What starts a branch's exact form: `~`, then its full name with each `/` written `~`, so
 * `canopycms/prod/spring` is `~canopycms~prod~spring` and a branch outside the namespace named
 * `spring` is `~spring`. That branch and the namespace branch `canopycms/prod/spring` both answer
 * to `spring`, which opens the namespace one; `~spring` opens the other. Git refuses `~` in a
 * branch name, so no other name starts with it and the mapping reverses exactly, and
 * `encodeURIComponent` leaves `~` alone, so a request path carries the form without `%2F`.
 */
const EXACT_BRANCH_MARK = '~'

/** Whether `param` is in the exact form, well formed or not: no branch name starts with `~`. */
export function isExactBranchForm(param: string): boolean {
  return param.startsWith(EXACT_BRANCH_MARK)
}

/** The exact form of the branch whose full name is `fullName`. */
export function exactBranchSegment(fullName: string): string {
  return `${EXACT_BRANCH_MARK}${fullName.replaceAll('/', EXACT_BRANCH_MARK)}`
}

/**
 * The full name the exact form `param` names, or null when `param` is no well-formed exact form:
 * it starts with `~`, holds no `/`, and with each later `~` read as `/` names a branch
 * `parseBranchRef` takes, which refuses an empty name or part (`~`, `~~a`, `~a~`).
 */
export function exactBranchName(param: string): string | null {
  if (!isExactBranchForm(param) || param.includes('/')) return null
  const named = parseBranchRef(
    param.slice(EXACT_BRANCH_MARK.length).replaceAll(EXACT_BRANCH_MARK, '/'),
  )
  return named.ok ? named.name : null
}

/**
 * Validate a branch named in a request, by a `/:branch` segment or `?branch=`, and cast it to
 * BranchName: a name `parseBranchRef` takes, or a well-formed exact form of one.
 */
export function parseBranchName(
  name: string,
): { ok: true; name: BranchName } | { ok: false; error: string } {
  if (typeof name === 'string' && isExactBranchForm(name)) {
    return exactBranchName(name) === null
      ? { ok: false, error: 'Branch name starts with "~" but names no branch' }
      : { ok: true, name: name as BranchName }
  }
  return parseBranchRef(name)
}

/**
 * Validate a branch's own name, the ref git and branch.json hold, against git's ref rules, except
 * that an inner part may start with `.` or end `.lock` (`a/.b`, `a.lock/b`), and cast it to
 * BranchName. It refuses every `~`, so the exact form is never one.
 */
export function parseBranchRef(
  name: string,
): { ok: true; name: BranchName } | { ok: false; error: string } {
  if (!name || typeof name !== 'string') {
    return { ok: false, error: 'Branch name is required' }
  }

  // Length limit (branch names become directory names).
  if (name.length > MAX_BRANCH_NAME_LENGTH) {
    return { ok: false, error: `Branch name too long (max ${MAX_BRANCH_NAME_LENGTH} characters)` }
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

/**
 * The branch an editor's typed name creates in `namespace`, or why it cannot: the typed name
 * sanitized, so it holds no `/`, is the short name, and the ref is the namespace followed by it.
 * `createBranchHandler` passes its resolved namespace; the editor, which is never told one, passes
 * none and checks the typed name alone, so its length limit is the looser one.
 */
export function parseCreatedBranchName(
  typed: string,
  namespace = '',
): { ok: true; name: BranchName; shortName: string } | { ok: false; error: string } {
  const valid = parseBranchRef(typed)
  if (!valid.ok) return valid
  if (namespace !== '' && typed.startsWith(namespace)) {
    return {
      ok: false,
      error: `Type only the branch's own name, without "${namespace}" in front: CanopyCMS adds it`,
    }
  }
  // Without a leading '-' or '.', which a branch name may not start with (`parseBranchRef`).
  const shortName = sanitizeBranchName(typed).replace(/^[-.]+/, '')
  // "_" alone would name a branch whose short name is no word at all.
  if (!/[a-zA-Z0-9]/.test(shortName)) {
    return { ok: false, error: 'Branch name needs at least one letter (a–z) or digit' }
  }
  const ref = `${namespace}${shortName}`
  if (ref.length > MAX_BRANCH_NAME_LENGTH) {
    return {
      ok: false,
      error: `Branch name too long (max ${MAX_BRANCH_NAME_LENGTH - namespace.length} characters)`,
    }
  }
  const parsed = parseBranchRef(ref)
  return parsed.ok ? { ok: true, name: parsed.name, shortName } : parsed
}

/** Validate a collection or entry slug and cast it to Slug. */
export function parseSlug(slug: string): { ok: true; slug: Slug } | { ok: false; error: string } {
  if (!slug) {
    return {
      ok: false,
      error: 'Slug is required',
    }
  }

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
