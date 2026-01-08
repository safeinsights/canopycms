import type { CanopyConfig } from './config'
import type { CanopyUser } from './user'
import type { CanopyServices } from './services'
import type { ContentReader, ReadContentInput } from './content-reader'
import { createCanopyServices } from './services'
import { isBuildMode, BUILD_USER } from './build-mode'
import { createContentReader } from './content-reader'

export interface CanopyContextOptions {
  /** Either config OR services must be provided */
  config?: CanopyConfig
  services?: CanopyServices
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
 */
export function createCanopyContext(options: CanopyContextOptions) {
  // Accept either pre-created services or config
  if (!options.services && !options.config) {
    throw new Error('CanopyCMS: Either services or config must be provided')
  }

  const services = options.services ?? createCanopyServices(options.config!)

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

    // Wrap reader to inject user automatically
    const read: CanopyContext['read'] = async <T = unknown>(input: {
      entryPath: string
      slug?: string
      branch?: string
      resolveReferences?: boolean
    }) => {
      const readInput: ReadContentInput = {
        ...input,
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
