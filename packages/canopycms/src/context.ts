import type { CanopyUser } from './user'
import type { CanopyServices } from './services'
import type { ReadContentInput } from './content-reader'
import { isDeployedStatic, isBuildMode, STATIC_DEPLOY_USER } from './build-mode'
import { createContentReader } from './content-reader'
import { ContentStoreError } from './content-store'
import { createLogicalPath, parseSlug, resolveBranchPaths, type Slug } from './paths'
import { resolveUrlPathCandidates } from './url-path-resolver'
import { loadOrCreateBranchContext } from './branch-workspace'
import {
  buildContentTree as buildContentTreeImpl,
  type BuildContentTreeOptions,
  type ContentTreeNode,
} from './content-tree'
import {
  listEntries as listEntriesImpl,
  type ListEntriesOptions,
  type ListEntriesItem,
} from './content-listing'

/** True when a ContentStoreError indicates a path/entry wasn't found (expected during candidate probing). */
const LOOKUP_FAILURE_PATTERNS = [/content not found/i, /no schema item found/i]
function isLookupFailure(err: ContentStoreError): boolean {
  return LOOKUP_FAILURE_PATTERNS.some((p) => p.test(err.message))
}

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

  /**
   * Read content by URL path, resolving the collection/entry split automatically.
   *
   * Tries direct entry match first (last segment = slug, rest = collection path),
   * then falls back to index entry (full path = collection, slug = 'index').
   * Returns null if no content matches the path.
   *
   * @example
   * ```ts
   * // URL /docs/guides/getting-started → reads content/docs/guides + slug "getting-started"
   * // URL /docs/guides → reads content/docs/guides + slug "index"
   * const result = await canopy.readByUrlPath<DocContent>('/docs/guides/getting-started')
   * if (result) {
   *   const { data, path } = result
   * }
   * ```
   */
  readByUrlPath: <T = unknown>(
    urlPath: string,
    options?: { branch?: string; resolveReferences?: boolean },
  ) => Promise<{ data: T; path: string } | null>

  /** Build a content tree from the schema and filesystem entries. */
  buildContentTree: <T = unknown>(
    options?: BuildContentTreeOptions<T>,
  ) => Promise<ContentTreeNode<T>[]>

  /** List all content entries as a flat array. */
  listEntries: <T = Record<string, unknown>>(
    options?: ListEntriesOptions<T>,
  ) => Promise<ListEntriesItem<T>[]>

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
   * Returns STATIC_DEPLOY_USER for static deployments or during build, otherwise delegates to adapter.
   */
  const getUser = async (): Promise<CanopyUser> => {
    // Static deployment or build phase: no request context, use synthetic admin user
    if (isDeployedStatic(services.config) || isBuildMode()) {
      return STATIC_DEPLOY_USER
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
      let slug: Slug | undefined
      if (input.slug) {
        const slugResult = parseSlug(input.slug)
        if (!slugResult.ok) {
          throw new Error(`Invalid slug: ${slugResult.error}`)
        }
        slug = slugResult.slug
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

    const readByUrlPath: CanopyContext['readByUrlPath'] = async <T = unknown>(
      urlPath: string,
      options?: { branch?: string; resolveReferences?: boolean },
    ) => {
      const contentRoot = services.config.contentRoot || 'content'
      const candidates = resolveUrlPathCandidates(urlPath, contentRoot)
      if (candidates.length === 0) return null

      const { branch, resolveReferences } = options ?? {}

      for (const candidate of candidates) {
        try {
          return await read<T>({
            entryPath: candidate.entryPath,
            slug: candidate.slug,
            branch,
            resolveReferences,
          })
        } catch (err) {
          // Only swallow "not found" errors from trying candidate paths.
          // Re-throw real errors (path traversal, permission, corruption).
          if (err instanceof ContentStoreError && isLookupFailure(err)) continue
          throw err
        }
      }

      return null
    }

    /** Resolve branch workspace and schema — shared by buildContentTree and listEntries. Memoized per getContext call. */
    let schemaContextPromise: ReturnType<typeof resolveSchemaContextImpl> | null = null
    const resolveSchemaContextImpl = async () => {
      const operatingMode = services.config.mode
      const defaultBranch = services.config.defaultBaseBranch ?? 'main'
      const branchContext = await loadOrCreateBranchContext({
        config: services.config,
        branchName: defaultBranch,
        mode: operatingMode,
        createdBy: 'canopycms-context',
        remoteUrl: services.config.defaultRemoteUrl,
      })
      const { branchRoot } = resolveBranchPaths(branchContext, operatingMode)
      const contentRootName = services.config.contentRoot || 'content'
      const { flatSchema } = await services.branchSchemaCache.getSchema(
        branchRoot,
        services.entrySchemaRegistry,
        contentRootName,
      )
      return { branchRoot, flatSchema, contentRootName }
    }
    const resolveSchemaContext = () => {
      if (!schemaContextPromise) {
        schemaContextPromise = resolveSchemaContextImpl()
      }
      return schemaContextPromise
    }

    const buildContentTree: CanopyContext['buildContentTree'] = async <T = unknown>(
      options?: BuildContentTreeOptions<T>,
    ) => {
      const { branchRoot, flatSchema, contentRootName } = await resolveSchemaContext()
      return buildContentTreeImpl<T>(branchRoot, flatSchema, contentRootName, options)
    }

    const listEntries: CanopyContext['listEntries'] = async <T = Record<string, unknown>>(
      options?: ListEntriesOptions<T>,
    ) => {
      const { branchRoot, flatSchema, contentRootName } = await resolveSchemaContext()
      return listEntriesImpl<T>(branchRoot, flatSchema, contentRootName, options)
    }

    return {
      read,
      readByUrlPath,
      buildContentTree,
      listEntries,
      services,
      user,
    }
  }

  return {
    getContext,
    services,
  }
}
