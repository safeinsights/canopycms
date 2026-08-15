import type { CanopyUser } from './user'
import type { CanopyServices } from './services'
import type { ReadContentInput, ContentReadMeta } from './content-reader'
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
  type DefaultEntryTypes,
} from './content-tree'
import {
  listEntries as listEntriesImpl,
  type ContentVisibilityOptions,
  type ListEntriesOptions,
  type ListEntriesItem,
} from './content-listing'
import { createDebugLogger } from './utils/debug'

const log = createDebugLogger({ prefix: 'Context' })

/** True when a ContentStoreError indicates a path/entry wasn't found (expected during candidate probing). */
function isLookupFailure(err: ContentStoreError): boolean {
  return err.code === 'NOT_FOUND' || err.code === 'NO_SCHEMA_ITEM'
}

/**
 * True when a ContentStoreError should render as "not found" to page-level callers of
 * readByUrlPath rather than escape as a thrown error. FORBIDDEN is included so a
 * denied/anonymous read produces the adopter's ordinary `if (!result) return notFound()`
 * (404) instead of an unhandled 500 from the server component. The strict `read()` API is
 * unaffected and still throws.
 */
function isPageSwallowable(err: ContentStoreError): boolean {
  return isLookupFailure(err) || err.code === 'FORBIDDEN'
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

/**
 * Build-time context.
 *
 * Obtained via getCanopyForBuild(); reads the filesystem directly as a synthetic admin
 * (STATIC_DEPLOY_USER) and bypasses all branch/path ACLs. Safe for static generation
 * (generateStaticParams, sitemap, build-time page rendering); it must NOT be used to serve
 * content at request time on a production `server` deployment. (Framework adapters throw on the
 * read helpers there; `services` remains a raw, unguarded escape hatch.) For request-scoped,
 * ACL-enforced access use getCanopy() (CanopyContext) instead.
 *
 * Includes read/readByUrlPath so build-time code can resolve a single entry by path/URL without
 * scanning the whole collection.
 */
export interface CanopyBuildContext {
  /**
   * Build a content tree from the schema and filesystem entries.
   *
   * Supply TEntryTypes (a map of entry type name → data shape, typically
   * derived via `TypeFromEntrySchema<typeof yourSchema>`) to get narrowed
   * access to `meta.indexEntry.data` inside the `extract` callback.
   *
   * Path ACLs: on the request-scoped context (`getCanopy()`), entries the current user
   * cannot `read` are omitted — from the emitted nodes AND from the `meta.indexEntry`
   * handed to `extract`. Collections whose children are all filtered out are pruned.
   * On the build context, and on static deployments, nothing is filtered (synthetic admin).
   */
  buildContentTree: <T = unknown, TEntryTypes = DefaultEntryTypes>(
    options?: BuildContentTreeOptions<T, TEntryTypes>,
  ) => Promise<ContentTreeNode<T>[]>

  /**
   * List all content entries as a flat array.
   *
   * Path ACLs: on the request-scoped context (`getCanopy()`), entries the current user
   * cannot `read` are omitted before `extract` runs. On the build context, and on static
   * deployments, nothing is filtered (synthetic admin).
   *
   * Branch: unlike `read`/`readByUrlPath`, this takes no `branch` option — it always lists
   * `defaultActiveBranch ?? defaultBaseBranch ?? 'main'`. In `dev` that tracks the git HEAD
   * via `refreshActiveBranch()`; in `prod` that refresh is a no-op, so this always reads the
   * base branch. See `.claude/future-tasks/context-listing-branch-pinning.md`.
   */
  listEntries: <T = Record<string, unknown>>(
    options?: ListEntriesOptions<T>,
  ) => Promise<ListEntriesItem<T>[]>

  /**
   * Content reader (auth context applied automatically — admin at build time).
   *
   * `meta.physicalPath` is the absolute filesystem path to the resolved entry file.
   * It is **server-only** — do not serialize it to the client or embed it in public
   * output, as it reveals the deployment's filesystem layout (home dir / EFS mount /
   * branch name). Intended for build-time reads of colocated artifacts, e.g.
   * `fs.readFile(path.join(path.dirname(result.meta.physicalPath), 'profile.json'))`.
   */
  read: <T = unknown>(input: {
    entryPath: string
    slug?: string
    branch?: string
    resolveReferences?: boolean
  }) => Promise<{
    data: T
    path: string
    meta: ContentReadMeta
  }>

  /**
   * Read content by URL path, resolving the collection/entry split automatically.
   *
   * Tries direct entry match first (last segment = slug, rest = collection path),
   * then falls back to index entry (full path = collection, slug = 'index').
   * Root path '/' resolves to the content root's index entry.
   * Returns null if no content matches the path — including collection URLs that have no
   * index entry (use buildContentTree for those) and non-entry/invalid paths such as
   * `/favicon.ico` or Next internals (the slug validator rejects them, treated as a miss).
   * Also returns null for paths the current user is not permitted to read (a FORBIDDEN
   * denial renders as a 404 via `notFound()` instead of a 500); the strict `read()` API
   * still throws on permission errors.
   *
   * The result's `meta.physicalPath` is the absolute filesystem path to the resolved
   * entry file. It is **server-only** — do not serialize it to the client or embed it
   * in public output, as it reveals the deployment's filesystem layout (home dir / EFS
   * mount / branch name). Intended for build-time reads of colocated artifacts.
   *
   * `meta.entryType` and `meta.entryId` are also resolved for free (path resolution
   * already derives them) — useful for entry-type-based dispatch in a single
   * catch-all route without a separate `listEntries` lookup or filename parse. See
   * `ContentReadMeta` (content-reader.ts) before branching on `entryType` for a legacy
   * file: `entryId === undefined` signals that `entryType` is a fallback, not a read.
   *
   * @example
   * ```ts
   * // URL /docs/guides/getting-started → reads content/docs/guides + slug "getting-started"
   * // URL /docs/guides → reads content/docs/guides + slug "index"
   * // URL / → reads content root + slug "index"
   * const result = await canopy.readByUrlPath<DocContent>('/docs/guides/getting-started')
   * if (result) {
   *   const { data, path } = result
   *   switch (result.meta.entryType) {
   *     case 'home': return <HomePage data={data} />
   *     default: return <DocView data={data} />
   *   }
   * }
   * ```
   */
  readByUrlPath: <T = unknown>(
    urlPath: string,
    options?: { branch?: string; resolveReferences?: boolean },
  ) => Promise<{
    data: T
    path: string
    meta: ContentReadMeta
  } | null>

  /** Underlying services */
  services: CanopyServices
}

export interface CanopyContext extends CanopyBuildContext {
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
    // Dev mode follows the developer's git HEAD (no-op in prod/static or when
    // defaultActiveBranch is explicit). Same contract as the HTTP API handler —
    // switching branches mid-session updates what getCanopy() serves.
    await services.refreshActiveBranch()
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
        // Skip candidates whose slug isn't a valid slug (e.g. URL paths like /favicon.ico or
        // Next internals that the [...slug] route catches). These can never match an entry, so
        // treat them as a miss rather than letting read() throw an "Invalid slug" error.
        if (!parseSlug(candidate.slug).ok) continue
        try {
          return await read<T>({
            entryPath: candidate.entryPath,
            slug: candidate.slug,
            branch,
            resolveReferences,
          })
        } catch (err) {
          // Swallow "not found" errors from trying candidate paths, and FORBIDDEN (a denied
          // or anonymous read renders as a 404 via the adopter's `if (!result) return
          // notFound()` rather than an unhandled 500). Re-throw real errors (validation,
          // corruption, non-ContentStoreError).
          if (err instanceof ContentStoreError && isPageSwallowable(err)) {
            if (err.code === 'FORBIDDEN') {
              log.debug('readByUrlPath', 'Read denied, treating as not-found: ' + err.message, {
                urlPath,
                entryPath: candidate.entryPath,
                slug: candidate.slug,
              })
            }
            continue
          }
          throw err
        }
      }

      return null
    }

    /** Resolve branch workspace and schema — shared by buildContentTree and listEntries. Memoized per getContext call. */
    let schemaContextPromise: ReturnType<typeof resolveSchemaContextImpl> | null = null
    const resolveSchemaContextImpl = async () => {
      const operatingMode = services.config.mode
      const defaultBranch =
        services.config.defaultActiveBranch ?? services.config.defaultBaseBranch ?? 'main'
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
      return { branchContext, branchRoot, flatSchema, contentRootName }
    }
    const resolveSchemaContext = () => {
      if (!schemaContextPromise) {
        schemaContextPromise = resolveSchemaContextImpl()
      }
      return schemaContextPromise
    }

    /**
     * Path-ACL predicate for the batch reads (listEntries / buildContentTree). Memoized
     * per getContext call, like the schema context above.
     *
     * These two are the only content reads on this context that did NOT enforce path
     * permissions: `read`/`readByUrlPath` go through the content reader, which checks per
     * entry, while the listing primitives took no user at all. Since `CanopyContext` is the
     * request-scoped, ACL-enforcing context that page code is told to use, an unfiltered
     * listing there disclosed full entry `data` for paths the user cannot `read()` directly.
     *
     * `services.createContentAccessChecker` is the existing batch primitive (api/entries.ts
     * uses the same one): it resolves the request-constant work — branch access, the
     * settings/permissions root, and the rule set — exactly once, and returns a synchronous
     * per-path check. So the per-entry cost here is an admin short-circuit or a minimatch
     * per configured rule, with no additional I/O.
     *
     * Returns an empty object (no predicate → unfiltered, today's behavior) at build time
     * and on static deployments. That short-circuit is load-bearing, not just an
     * optimization: those callers run as the synthetic admin STATIC_DEPLOY_USER, for whom
     * the predicate is a no-op anyway, and building it would add a getSettingsBranchRoot()
     * call — an EFS round trip in prod — to every build-time listing.
     *
     * Deliberately NOT wrapped in a try/catch: createContentAccessChecker is fail-loud by
     * contract, and swallowing here would silently serve an unfiltered listing.
     */
    let visibilityPromise: Promise<ContentVisibilityOptions> | null = null
    const resolveVisibilityImpl = async (): Promise<ContentVisibilityOptions> => {
      if (isDeployedStatic(services.config) || isBuildMode()) return {}
      const { branchContext, branchRoot } = await resolveSchemaContext()
      const checkAccess = await services.createContentAccessChecker(branchContext, branchRoot, user)
      return { shouldInclude: (physicalPath) => checkAccess(physicalPath, 'read').allowed }
    }
    const resolveVisibility = () => {
      if (!visibilityPromise) {
        visibilityPromise = resolveVisibilityImpl()
      }
      return visibilityPromise
    }

    const buildContentTree: CanopyContext['buildContentTree'] = async <
      T = unknown,
      TEntryTypes = DefaultEntryTypes,
    >(
      options?: BuildContentTreeOptions<T, TEntryTypes>,
    ) => {
      const { branchRoot, flatSchema, contentRootName } = await resolveSchemaContext()
      return buildContentTreeImpl<T, TEntryTypes>(
        branchRoot,
        flatSchema,
        contentRootName,
        options,
        await resolveVisibility(),
      )
    }

    const listEntries: CanopyContext['listEntries'] = async <T = Record<string, unknown>>(
      options?: ListEntriesOptions<T>,
    ) => {
      const { branchRoot, flatSchema, contentRootName } = await resolveSchemaContext()
      return listEntriesImpl<T>(
        branchRoot,
        flatSchema,
        contentRootName,
        options,
        await resolveVisibility(),
      )
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
