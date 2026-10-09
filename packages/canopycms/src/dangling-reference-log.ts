import { canopyLogWarn } from './utils/logger'

/**
 * Bounds the dedupe set below. A process that has seen this many distinct dangling references
 * stops warning about new ones rather than growing without limit; the build guard still lists
 * every one.
 */
const MAX_WARNED = 1000

/**
 * Dangling references already reported by this process. A log dedupe only, never consulted for
 * content, so its module lifetime carries none of the staleness hazards in docs/concurrency.md:
 * at worst a reference repaired and broken again is not re-reported until restart.
 */
const warned = new Set<string>()

export interface DanglingReferenceSite {
  /** Workspace the entry was read from, so two branches' identical paths warn separately. */
  root: string
  /** Logical path of the referring entry, when the caller knows it. */
  entry?: string
  /** Field path in `traverseFields`' format, e.g. `blocks[2].author` or `reviewers[1]`. */
  path: string
  /** The id that names no readable entry. */
  id: string
}

/** Warn once per process that a reference names no readable entry. */
export function warnDanglingReference(site: DanglingReferenceSite): void {
  const key = `${site.root}\0${site.entry ?? ''}\0${site.path}\0${site.id}`
  if (warned.has(key) || warned.size >= MAX_WARNED) return
  warned.add(key)
  canopyLogWarn(
    `CanopyCMS: ${site.entry ?? 'an entry'} field "${site.path}" references missing entry ${site.id}; ` +
      'it resolves as unavailable until the reference is repointed or cleared.',
  )
}

/**
 * Forget every reported reference.
 * @internal Exported for tests.
 */
export function resetDanglingReferenceWarnings(): void {
  warned.clear()
}
