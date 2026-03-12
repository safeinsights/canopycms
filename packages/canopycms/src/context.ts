import type { CanopyUser } from './user'
import type { CanopyServices } from './services'
import type { ContentReader, ReadContentInput } from './content-reader'
import { isBuildMode, BUILD_USER } from './build-mode'
import { createContentReader } from './content-reader'
import { createLogicalPath, parseSlug, type EntrySlug } from './paths'

export interface CanopyContextOptions {
  services: CanopyServices
  /**
   * Extract the current user from framework-specific context.
   * Should call authResultToCanopyUser() to apply bootstrap admin groups.
   *
   * Framework adapters provide this (e.g., from Next.js headers, Express req, etc.)
   */
  extractUser: () => Promise<CanopyUser>
}

export interface CanopyContext {
  /** Content reader with automatic auth context */
  read: <T = unknown>(input: {
    entryPath: string
    slug?: string
    branch?: string
    resolveReferences?: boolean
  }) => Promise<{ data: T; path: string }>

  /** Underlying services */
  services: CanopyServices

  /** Current authenticated user */
  user: CanopyUser
}

/**
 * Create a Canopy context that manages auth + content reading.
 * Framework-agnostic - the adapter provides the extractUser function.
 *
 * User extractor should apply bootstrap admin groups (via authResultToCanopyUser).
 *
 * NOTE: This function is synchronous because in practice, services are always
 * provided pre-created (async) by the framework adapter. The fallback path
 * that creates services from config cannot work correctly since createCanopyServices
 * is now async. Always pass services, not config.
 */
export function createCanopyContext(options: CanopyContextOptions) {
  const services = options.services

  /**
   * Get the current user.
   * Returns BUILD_USER during static generation, otherwise delegates to adapter.
   */
  const getUser = async (): Promise<CanopyUser> => {
    // Build mode: static generation gets admin access
    if (isBuildMode()) {
      return BUILD_USER
    }

    // Runtime: delegate to adapter-provided user extractor
    // (adapter should use authResultToCanopyUser to apply bootstrap admins)
    return await options.extractUser()
  }

  /**
   * Get the context for the current request.
   * Call this in server components/routes to get auth-aware reader.
   */
  const getContext = async (): Promise<CanopyContext> => {
    const user = await getUser()

    // Create base content reader
    const baseReader = createContentReader({ services })

    // Wrap reader to inject user automatically, validating strings → branded types at this boundary
    const read: CanopyContext['read'] = async <T = unknown>(input: {
      entryPath: string
      slug?: string
      branch?: string
      resolveReferences?: boolean
    }) => {
      const entryPath = createLogicalPath(input.entryPath)
      let slug: EntrySlug | undefined
      if (input.slug) {
        const slugResult = parseSlug(input.slug, 'entry')
        if (!slugResult.ok) {
          throw new Error(`Invalid slug: ${slugResult.error}`)
        }
        slug = slugResult.slug as EntrySlug
      }
      const readInput: ReadContentInput = {
        entryPath,
        slug,
        branch: input.branch,
        user,
        resolveReferences: input.resolveReferences ?? true,
      }
      return baseReader.read<T>(readInput)
    }

    return {
      read,
      services,
      user,
    }
  }

  return {
    getContext,
    services,
  }
}
