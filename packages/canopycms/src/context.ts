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
 * A `branch` arrives from the request (a page passing `?branch=`), so only the
 * active branch is ever provisioned here; any other name must already exist and
 * pass the user's branch access before its files are read (`resolveBranch`).
 *
 * The Next.js adapter wraps this in React `cache()` for per-request memoization
 * (`canopycms-next/src/context-wrapper.ts`).
 *
 * Module map: ./AGENTS.md.
 */
import type { CanopyUser } from './user'
import type { CanopyServices } from './services'
import type { ReadContentInput, ContentReadMeta } from './content-reader'
import type { BranchContext } from './types'
import type { OperatingMode } from './operating-mode'
import type { FlatSchemaItem } from './config'
import { isDeployedStatic, isBuildMode, readsFromCheckout, STATIC_DEPLOY_USER } from './build-mode'
import { createContentReader } from './content-reader'
import { ContentStoreError } from './content-store'
import {
  createLogicalPath,
  namesNoWorkspace,
  parseSlug,
  resolveBranchPaths,
  type Slug,
} from './paths'
import { resolveUrlPathCandidates } from './url-path-resolver'
import { loadBranchContext, loadOrCreateBranchContext } from './branch-workspace'
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

/**
 * A `branch` option is typed `string` but usually handed over from untyped
 * request input: a repeated `?branch=` arrives as an array, which names no
 * branch, and `URLSearchParams.get` gives null for an absent one, which is no
 * `branch` at all.
 */
function isBranchOption(branch: unknown): branch is string | null | undefined {
  return branch == null || typeof branch === 'string'
}

interface ListingSource {
  branchRoot: string
  flatSchema: FlatSchemaItem[]
  contentRootName: string
  visibility: ContentVisibilityOptions
}

/**
 * A branch that already has a workspace, or null. A name that cannot name one
 * is null too (`namesNoWorkspace`): it arrives from the request, so it reads as
 * not-found rather than failing the page.
 */
async function loadExistingBranch(
  branchName: string,
  mode: OperatingMode,
): Promise<BranchContext | null> {
  try {
    return await loadBranchContext({ branchName, mode })
  } catch (err) {
    if (namesNoWorkspace(err)) return null
    throw err
  }
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
   *
   * Branch: the `branch` option behaves as on `listEntries`.
   */
  buildContentTree: <T = unknown, TEntryTypes = DefaultEntryTypes>(
    options?: BuildContentTreeOptions<T, TEntryTypes> & { branch?: string },
  ) => Promise<ContentTreeNode<T>[]>

  /**
   * Every content entry as a flat array.
   *
   * Path ACLs: on the request-scoped context (`getCanopy()`), entries the user
   * cannot `read` are omitted before `extract` runs; on the build context and
   * static deployments nothing is filtered.
   *
   * Branch: with no `branch` it lists the active branch
   * (`defaultActiveBranch ?? defaultBaseBranch`): git HEAD in `dev` when that is
   * unset, otherwise usually the base branch in `prod`. Pass the preview
   * iframe's `?branch=` as `branch`, as for `read`, so an index page previewed
   * on a content branch lists that branch. Any other branch must already exist
   * and, on the request-scoped context, be readable by the user; otherwise, or
   * for an array, the result is empty. It selects nothing at build
   * time or on static deployments.
   */
  listEntries: <T = Record<string, unknown>>(
    options?: ListEntriesOptions<T> & { branch?: string },
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
   *
   * Branch: with no `branch` it reads the active branch, provisioning its workspace if missing.
   * Any other branch must already exist and, on the request-scoped context, be readable by the
   * user; otherwise, or for an array, it throws NOT_FOUND, so a hidden branch reads as a missing
   * one. It selects nothing at build time or on static deployments.
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
   * rejects, a missing branch, or a path or branch the user may not read, so a
   * denial renders as a 404 via `notFound()`, not a 500. Strict `read()` throws.
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

    // Read once, so every read and listing in this request agrees on it even if
    // a concurrent request's refreshActiveBranch() replaces services.config.
    const activeBranch =
      services.config.defaultActiveBranch ?? services.config.defaultBaseBranch ?? 'main'

    // No ACL enforcement at build time, on static deployments, or for the
    // synthetic admin. For the last this is load-bearing, not an optimization:
    // that user has unconditional access anyway (path checks bypass entirely for
    // an Admins-group user — authorization/path.ts), but BUILDING a path checker
    // costs a getSettingsBranchRoot() call, which in modes with a separate
    // settings branch provisions that branch's git workspace: an EFS round trip
    // in prod. `createBuildCanopy` (build-canopy.ts) runs outside a request or
    // Next.js build phase, so neither other guard fires for it, and without this
    // one every such script pays for a settings-workspace clone it never needed —
    // and hard-fails where that workspace cannot be provisioned. Compared by
    // reference to the STATIC_DEPLOY_USER singleton, not by group membership, so
    // a real authenticated admin at request time still goes through the real
    // check.
    const enforceAcls = !(
      isDeployedStatic(services.config) ||
      isBuildMode() ||
      user === STATIC_DEPLOY_USER
    )

    /**
     * `branch` when it names a branch other than the active one, else undefined:
     * no `branch`, an empty one, the active one named explicitly, or any name
     * when reading from the checkout, where it selects nothing.
     */
    const otherBranch = (branch: string | null | undefined): string | undefined =>
      branch && branch !== activeBranch && !readsFromCheckout(services.config) ? branch : undefined

    /**
     * The workspace for the active branch (undefined) or another named one, or
     * null when it yields nothing this user may see.
     *
     * The active branch is provisioned if missing. Any other name is load-only,
     * never provisioned — a name with no workspace is null (`loadExistingBranch`) — and its branch
     * access, held in its own metadata, is checked here, before its schema or
     * content files are read, so a denied branch is indistinguishable from a
     * missing one. The active branch's access is left to the caller: a listing
     * of it lists nothing, and a strict `read` of it throws FORBIDDEN.
     */
    const resolveBranch = async (requested: string | undefined): Promise<BranchContext | null> => {
      if (requested === undefined) {
        return loadOrCreateBranchContext({
          config: services.config,
          branchName: activeBranch,
          mode: services.config.mode,
          createdBy: 'canopycms-context',
          remoteUrl: services.config.defaultRemoteUrl,
        })
      }
      const context = await loadExistingBranch(requested, services.config.mode)
      if (!context) return null
      if (enforceAcls && !services.checkBranchAccess(context, user).allowed) return null
      return context
    }

    // The reader resolves every branch through resolveBranch; a null reads as
    // NOT_FOUND. Reads from the checkout bypass the resolver inside the reader.
    const baseReader = createContentReader({
      services,
      defaultBranch: activeBranch,
      getBranchContext: (branchName) => resolveBranch(otherBranch(branchName)),
    })

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
      if (!isBranchOption(input.branch)) {
        throw new ContentStoreError(`Branch not found: ${String(input.branch)}`, 'NOT_FOUND')
      }
      const readInput: ReadContentInput = {
        entryPath,
        slug,
        branch: input.branch ?? undefined,
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

    /**
     * What a batch read (listEntries / buildContentTree) lists from: the branch's
     * schema plus its path-ACL predicate, or null when the branch yields nothing
     * this user may see. The branch resolves as for `read` (`resolveBranch`). At
     * build time and on static deployments `branch` selects nothing, as for
     * `read` (see the module doc).
     *
     * Memoized per getContext call and per branch name, on the in-flight
     * promise; a null result is memoized too, so one request answers a given
     * name consistently. The memo is request-scoped, so it carries no
     * generation protocol (docs/concurrency.md, "Adding a call-scoped memo").
     */
    const listingSources = new Map<string, Promise<ListingSource | null>>()
    const resolveListingSource = (branch: unknown): Promise<ListingSource | null> => {
      if (!isBranchOption(branch)) return Promise.resolve(null)
      const requested = otherBranch(branch)
      const key = requested ?? activeBranch
      let source = listingSources.get(key)
      if (!source) {
        source = resolveListingSourceImpl(requested)
        listingSources.set(key, source)
      }
      return source
    }
    const resolveListingSourceImpl = async (
      requested: string | undefined,
    ): Promise<ListingSource | null> => {
      const operatingMode = services.config.mode
      const branchContext = await resolveBranch(requested)
      if (!branchContext) return null
      // resolveBranch has already checked any other branch.
      if (
        requested === undefined &&
        enforceAcls &&
        !services.checkBranchAccess(branchContext, user).allowed
      ) {
        return null
      }

      const { branchRoot } = resolveBranchPaths(branchContext, operatingMode)
      const contentRootName = services.config.contentRoot || 'content'
      const { flatSchema } = await services.branchSchemaCache.getSchema(
        branchRoot,
        services.entrySchemaRegistry,
        contentRootName,
      )
      if (!enforceAcls) return { branchRoot, flatSchema, contentRootName, visibility: {} }

      // The path-ACL predicate keeps an unfiltered listing on this ACL-enforcing
      // context from disclosing entry `data` for paths the user cannot `read()`.
      // `services.createContentAccessChecker` is the shared batch primitive
      // (api/entries.ts uses it too): it resolves the request-constant work —
      // branch access, the settings/permissions root, the rule set — once, and
      // returns a synchronous per-path check, so the per-entry cost is an admin
      // short-circuit or one minimatch per configured rule, with no extra I/O.
      //
      // Deliberately NOT wrapped in try/catch — createContentAccessChecker is
      // fail-loud by contract, and swallowing would serve an unfiltered listing.
      const checkAccess = await services.createContentAccessChecker(branchContext, branchRoot, user)
      return {
        branchRoot,
        flatSchema,
        contentRootName,
        visibility: { shouldInclude: (logicalPath) => checkAccess(logicalPath, 'read').allowed },
      }
    }

    const buildContentTree: CanopyContext['buildContentTree'] = async <
      T = unknown,
      TEntryTypes = DefaultEntryTypes,
    >(
      options?: BuildContentTreeOptions<T, TEntryTypes> & { branch?: string },
    ) => {
      const { branch, ...treeOptions } = options ?? {}
      const source = await resolveListingSource(branch)
      if (!source) return []
      return buildContentTreeImpl<T, TEntryTypes>(
        source.branchRoot,
        source.flatSchema,
        source.contentRootName,
        treeOptions,
        source.visibility,
      )
    }

    const listEntries: CanopyContext['listEntries'] = async <T = Record<string, unknown>>(
      options?: ListEntriesOptions<T> & { branch?: string },
    ) => {
      const { branch, ...listOptions } = options ?? {}
      const source = await resolveListingSource(branch)
      if (!source) return []
      return listEntriesImpl<T>(
        source.branchRoot,
        source.flatSchema,
        source.contentRootName,
        listOptions,
        source.visibility,
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
