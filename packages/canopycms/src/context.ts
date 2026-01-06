import type { CanopyConfig } from './config'
import type { CanopyUser } from './user'
import type { CanopyServices } from './services'
import type { ContentReader, ReadContentInput } from './content-reader'
import { createCanopyServices, getEffectiveGroups } from './services'
import { isBuildMode, BUILD_USER } from './build-mode'
import { ANONYMOUS_USER } from './user'
import { createContentReader } from './content-reader'

export interface CanopyContextOptions {
  config: CanopyConfig
  /**
   * Function to extract the current user.
   * Framework adapters provide this (e.g., from Next.js headers, Express req, etc.)
   */
  getUser: () => Promise<CanopyUser>
}

export interface CanopyContext {
  /** Content reader with automatic auth context */
  read: <T = unknown>(input: {
    entryPath: string
    slug?: string
    branch?: string
  }) => Promise<{ data: T; path: string }>

  /** Underlying services */
  services: CanopyServices

  /** Current authenticated user */
  user: CanopyUser
}

/**
 * Create a Canopy context that manages auth + content reading.
 * Framework-agnostic - the adapter provides the getUser function.
 *
 * This applies bootstrap admin groups automatically and handles build mode.
 */
export function createCanopyContext(options: CanopyContextOptions) {
  const services = createCanopyServices(options.config)

  /**
   * Get the current user with bootstrap admin groups applied.
   */
  const getUserWithBootstrap = async (): Promise<CanopyUser> => {
    // Build mode: bypass auth, return admin user
    if (isBuildMode()) {
      return BUILD_USER
    }

    // Get user from adapter-provided function
    const user = await options.getUser()

    // Anonymous user: no groups to apply
    if (user.type === 'anonymous') {
      return user
    }

    // Apply bootstrap admin groups
    const effectiveGroups = getEffectiveGroups(
      user.userId,
      user.groups,
      services.bootstrapAdminIds
    )

    return {
      ...user,
      groups: effectiveGroups,
    }
  }

  /**
   * Get the context for the current request.
   * Call this in server components/routes to get auth-aware reader.
   */
  const getContext = async (): Promise<CanopyContext> => {
    const user = await getUserWithBootstrap()

    // Create base content reader
    const baseReader = createContentReader({ services })

    // Wrap reader to inject user automatically
    const read: CanopyContext['read'] = async <T = unknown>(input: {
      entryPath: string
      slug?: string
      branch?: string
    }) => {
      const readInput: ReadContentInput = {
        ...input,
        user,
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
