/**
 * `createCanopyContext` — the per-REQUEST content facade.
 *
 * Binds a user and a branch to the long-lived `CanopyServices` (see
 * `services.ts`) and exposes the read surface page code and API handlers
 * actually call: `read`, `readByUrlPath`, listing and tree helpers. This is the
 * layer where authorization is applied, so a read that bypasses it bypasses
 * path ACLs.
 *
 * PHASE-AWARE: at build time (`isBuildMode`) or on a static deployment
 * (`isDeployedStatic`) it authorizes as `STATIC_DEPLOY_USER` rather than a real
 * user (WHO) and reads the working tree at `process.cwd()` rather than a branch
 * workspace (WHERE: `readsFromCheckout`, applied inside
 * `loadOrCreateBranchContext`), so a `branch` passed to a read selects nothing.
 * Only request-time reads on a server deployment resolve a branch workspace —
 * in dev, the clone under `.canopy-dev/content-branches/`.
 *
 * The Next.js adapter wraps this in React `cache()` for per-request memoization
 * (`canopycms-next/src/context-wrapper.ts`).
 *
 * Module map: ./AGENTS.md.
 */
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
 * True when a ContentStoreError should render as "not found" to page-level
 * callers of readByUrlPath rather than escape as a thrown error. FORBIDDEN is
 * included so a denied or anonymous read reaches the adopter's ordinary
 * `if (!result) return notFound()` (404) instead of an unhandled 500 from the
 * server component. The strict `read()` API still throws.
 */
function isPageSwallowable(err: ContentStoreError): boolean {
  return isLookupFailure(err) || err.code === 'FORBIDDEN'
}

export interface CanopyContextOptions {
  services: CanopyServices
  /**
   * Extract the current user from framework-specific context — supplied by the
   * framework adapter, and must call authResultToCanopyUser() so bootstrap
   * admin groups are applied.
   */
  extractUser: () => Promise<CanopyUser>
}

/**
 * Build-time context, from getCanopyForBuild(): reads the filesystem directly
 * as a synthetic admin (STATIC_DEPLOY_USER), bypassing all branch and path
 * ACLs. Use it for static generation — generateStaticParams, sitemap,
 * build-time page rendering — and never to serve content at request time on a
 * production `server` deployment; request-time, ACL-enforced access is
 * getCanopy() (CanopyContext). Framework adapters throw on the read helpers
 * there, though `services` stays a raw, unguarded escape hatch.
 *
 * It carries read/readByUrlPath so build-time code can resolve a single entry
 * by path or URL without scanning the whole collection.
 */
export interface CanopyBuildContext {
  /**
   * Build a content tree from the schema and filesystem entries. Supply
   * TEntryTypes (entry type name → data shape, typically via
   * `TypeFromEntrySchema<typeof yourSchema>`) for narrowed access to
   * `meta.indexEntry.data` inside `extract`.
   *
   * Path ACLs: on the request-scoped context (`getCanopy()`), entries the user
   * cannot `read` are omitted from the emitted nodes AND from the
   * `meta.indexEntry` handed to `extract`, and a collection whose children are
   * all filtered out is pruned. On the build context and on static deployments
   * nothing is filtered — the synthetic admin sees everything.
   */
  buildContentTree: <T = unknown, TEntryTypes = DefaultEntryTypes>(
    options?: BuildContentTreeOptions<T, TEntryTypes>,
  ) => Promise<ContentTreeNode<T>[]>

  /**
   * Every content entry as a flat array.
   *
   * Path ACLs: on the request-scoped context (`getCanopy()`), entries the user
   * cannot `read` are omitted before `extract` runs; on the build context and
   * static deployments nothing is filtered.
   *
   * Branch: unlike `read`/`readByUrlPath` this takes no `branch` option, always
   * listing `defaultActiveBranch ?? defaultBaseBranch ?? 'main'`. In `dev` that
   * tracks git HEAD via `refreshActiveBranch()`; in `prod` the refresh is a
   * no-op, so it always reads the base branch. See
   * `.claude/future-tasks/context-listing-branch-pinning.md`.
   */
  listEntries: <T = Record<string, unknown>>(
    options?: ListEntriesOptions<T>,
  ) => Promise<ListEntriesItem<T>[]>

  /**
   * Content reader, with the auth context applied automatically (admin at build
   * time).
   *
   * `meta.physicalPath` is the resolved entry file's absolute path, and is
   * **server-only**: never serialize it to the client or embed it in public
   * output, since it reveals the deployment's filesystem layout (home dir, EFS
   * mount, branch name). It is for build-time reads of colocated artifacts, e.g.
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
   * Read content by URL path, resolving the collection/entry split itself: a
   * direct entry match first (last segment = slug, rest = collection path),
   * then the index entry (full path = collection, slug = 'index'). Both need a
   * real collection for the collection part; root '/' is the content root's
   * index entry.
   *
   * Resolves ONLY what `listEntries` publishes — `readByUrlPath(item.urlPath)`
   * reaches the entry and no other spelling does; a collection literally named
   * `index` still resolves, via the index fallback. `read({ entryPath })` is
   * deliberately NOT narrowed this way: a schema path is a different question
   * from a published URL, and reaches a singleton whose slug nobody knows.
   *
   * Null when nothing matches — a collection URL with no index entry (use
   * buildContentTree), a non-entry path like `/favicon.ico` the slug validator
   * rejects, or a path the user may not read, so a FORBIDDEN denial renders as
   * a 404 via `notFound()` rather than a 500. Strict `read()` still throws.
   *
   * `meta.physicalPath` is **server-only**, for the reason given on `read`.
   * `meta.entryType`/`entryId` come free with path resolution, so one catch-all
   * route can dispatch on entry type with no extra lookup; check
   * `ContentReadMeta` first — `entryId === undefined` marks `entryType` a
   * fallback, not a read.
   *
   * @example
   * ```ts
   * const result = await canopy.readByUrlPath<DocContent>('/docs/guides/intro')
   * if (result?.meta.entryType === 'home') return <HomePage data={result.data} />
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
 * Create a Canopy context managing auth + content reading. Framework-agnostic:
 * the adapter supplies extractUser.
 *
 * Synchronous, and takes pre-created `services` rather than config — building
 * services is async, so there is no working fallback path from config here.
 */
export function createCanopyContext(options: CanopyContextOptions) {
  const services = options.services

  /** STATIC_DEPLOY_USER on a static deployment or during build, else the adapter's user. */
  const getUser = async (): Promise<CanopyUser> => {
    // No request context in either phase, so use the synthetic admin.
    if (isDeployedStatic(services.config) || isBuildMode()) {
      return STATIC_DEPLOY_USER
    }

    return await options.extractUser()
  }

  /** The auth-aware context for this request; call it in server components and routes. */
  const getContext = async (): Promise<CanopyContext> => {
    // Dev mode follows the developer's git HEAD (no-op in prod/static or when
    // defaultActiveBranch is explicit). Same contract as the HTTP API handler —
    // switching branches mid-session updates what getCanopy() serves.
    await services.refreshActiveBranch()
    const user = await getUser()

    const baseReader = createContentReader({ services })

    // Injects the user and validates strings → branded types at this boundary.
    // `extra` carries options that are NOT part of the public `read` surface —
    // today just readByUrlPath's URL-addressability gate. A separate inner
    // function rather than an optional second parameter on the
    // `CanopyContext['read']`-typed closure, so the two call sites stay visible
    // and nobody widens the public API by accident.
    const readWithOptions = async <T = unknown>(
      input: {
        entryPath: string
        slug?: string
        branch?: string
        resolveReferences?: boolean
      },
      extra?: Pick<ReadContentInput, 'urlAddressableOnly'>,
    ) => {
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
        ...extra,
      }
      return baseReader.read<T>(readInput)
    }

    const read: CanopyContext['read'] = (input) => readWithOptions(input)

    const readByUrlPath: CanopyContext['readByUrlPath'] = async <T = unknown>(
      urlPath: string,
      options?: { branch?: string; resolveReferences?: boolean },
    ) => {
      const contentRoot = services.config.contentRoot || 'content'
      const candidates = resolveUrlPathCandidates(urlPath, contentRoot)
      if (candidates.length === 0) return null

      const { branch, resolveReferences } = options ?? {}

      for (const candidate of candidates) {
        // Skip a candidate whose slug isn't valid (/favicon.ico, Next internals
        // the [...slug] route catches). None can match an entry, so treat it as
        // a miss rather than let read() throw "Invalid slug".
        if (!parseSlug(candidate.slug).ok) continue
        try {
          return await readWithOptions<T>(
            {
              entryPath: candidate.entryPath,
              slug: candidate.slug,
              branch,
              resolveReferences,
            },
            // A read BY PUBLISHED URL accepts only what listEntries publishes.
            // See ReadContentInput.urlAddressableOnly for the two rules, and
            // why they live in the reader (which holds the branch-correct
            // schema) rather than the candidate builder (pure and schema-free).
            { urlAddressableOnly: true },
          )
        } catch (err) {
          // Swallow a candidate path's "not found", and FORBIDDEN so a denied
          // or anonymous read renders as the adopter's 404 rather than an
          // unhandled 500. Real errors (validation, corruption, anything not a
          // ContentStoreError) rethrow.
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
     * Path-ACL predicate for the batch reads (listEntries / buildContentTree),
     * memoized per getContext call like the schema context above. Without it an
     * unfiltered listing on this request-scoped, ACL-enforcing context would
     * disclose full entry `data` for paths the user cannot `read()` directly.
     *
     * `services.createContentAccessChecker` is the shared batch primitive
     * (api/entries.ts uses it too): it resolves the request-constant work —
     * branch access, the settings/permissions root, the rule set — once, and
     * returns a synchronous per-path check, so the per-entry cost is an admin
     * short-circuit or one minimatch per configured rule, with no extra I/O.
     *
     * The empty object (no predicate → unfiltered) at build time, on static
     * deployments, and for the synthetic admin is load-bearing, not an
     * optimization. That user has unconditional access anyway (path checks
     * bypass entirely for an Admins-group user — authorization/path.ts), but
     * BUILDING the checker costs a getSettingsBranchRoot() call, which in modes
     * with a separate settings branch provisions that branch's git workspace: an
     * EFS round trip in prod. `createBuildCanopy` (build-canopy.ts) runs outside
     * a request or Next.js build phase, so neither other guard fires for it, and
     * without this one every such script pays for a settings-workspace clone it
     * never needed — and hard-fails where that workspace cannot be provisioned.
     *
     * Compared by reference to the STATIC_DEPLOY_USER singleton, not by group
     * membership, so it stays scoped to the synthetic build identity: a real
     * authenticated admin at request time still goes through the real check.
     *
     * Deliberately NOT wrapped in try/catch — createContentAccessChecker is
     * fail-loud by contract, and swallowing would serve an unfiltered listing.
     */
    let visibilityPromise: Promise<ContentVisibilityOptions> | null = null
    const resolveVisibilityImpl = async (): Promise<ContentVisibilityOptions> => {
      if (isDeployedStatic(services.config) || isBuildMode() || user === STATIC_DEPLOY_USER)
        return {}
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
