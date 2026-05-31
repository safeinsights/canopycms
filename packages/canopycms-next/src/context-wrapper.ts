import path from 'node:path'
import { cache } from 'react'
import { headers } from 'next/headers'
import {
  createCanopyContext,
  isBuildMode,
  startDevContentWatcher,
  type CanopyContext,
  type CanopyBuildContext,
  type CanopyServices,
  type BuildContentTreeOptions,
  type ContentTreeNode,
  type ListEntriesOptions,
  type ListEntriesItem,
  createCanopyServices,
  operatingStrategy,
  loadInternalGroups,
  loadBranchContext,
  STATIC_DEPLOY_USER,
} from 'canopycms/server'
import type { CanopyConfig, AuthPlugin, CanopyUser, FieldConfig } from 'canopycms'
import { authResultToCanopyUser } from 'canopycms'
import type { InternalGroup } from 'canopycms/server'
import { CachingAuthPlugin, FileBasedAuthCache } from 'canopycms/auth/cache'
import { createCanopyCatchAllHandler } from './adapter'

let warnedNoAdmins = false
let warnedStaticMode = false

/**
 * Stub auth plugin for static deployments where no real auth is needed.
 * Returns unauthenticated for all requests — API routes will return 401.
 */
const staticDeployAuthPlugin: AuthPlugin = {
  async authenticate() {
    return { success: false as const, error: 'No auth plugin configured (static deployment)' }
  },
  async searchUsers() {
    return []
  },
  async getUserMetadata() {
    return null
  },
  async getGroupMetadata() {
    return null
  },
  async listGroups() {
    return []
  },
}

export interface NextCanopyOptions {
  config: CanopyConfig
  /** Auth plugin for user authentication. Optional for static deployments (deployedAs: 'static'). */
  authPlugin?: AuthPlugin
  entrySchemaRegistry: Record<string, readonly FieldConfig[]>
}

/**
 * Wrap a build context so its operations throw if used at request time on a `server` deployment.
 *
 * On a `server` deployment the request-scoped getCanopy() enforces branch/path ACLs, but the build
 * context runs as a synthetic admin and bypasses them — using it in a request path would leak
 * ACL-protected content. On a `static` deployment there is no runtime authorization to bypass (the
 * public site is pre-built files), so no guard is applied — and a blanket guard would false-positive
 * on legitimate build helpers (generateStaticParams/sitemap) that Next can invoke in dev without
 * isBuildMode(). CANOPY_BUILD_MODE=true is the escape hatch for non-Next static generation.
 */
function guardBuildContext(buildCtx: CanopyBuildContext, config: CanopyConfig): CanopyBuildContext {
  const assertBuildPhase = (method: string): void => {
    if (config.deployedAs === 'server' && !isBuildMode()) {
      throw new Error(
        `CanopyCMS: getCanopyForBuild().${method}() was called at request time on a 'server' ` +
          'deployment. The build context bypasses all branch and path ACLs and must only be used ' +
          'during static generation (next build / CANOPY_BUILD_MODE=true). Use the request-scoped ' +
          'getCanopy() instead, or the auto-selecting read()/readByUrlPath() from createNextCanopyContext.',
      )
    }
  }
  return {
    services: buildCtx.services,
    buildContentTree: <T = unknown>(
      options?: BuildContentTreeOptions<T>,
    ): Promise<ContentTreeNode<T>[]> => {
      assertBuildPhase('buildContentTree')
      return buildCtx.buildContentTree<T>(options)
    },
    listEntries: <T = Record<string, unknown>>(
      options?: ListEntriesOptions<T>,
    ): Promise<ListEntriesItem<T>[]> => {
      assertBuildPhase('listEntries')
      return buildCtx.listEntries<T>(options)
    },
    read: <T = unknown>(input: {
      entryPath: string
      slug?: string
      branch?: string
      resolveReferences?: boolean
    }): Promise<{ data: T; path: string }> => {
      assertBuildPhase('read')
      return buildCtx.read<T>(input)
    },
    readByUrlPath: <T = unknown>(
      urlPath: string,
      options?: { branch?: string; resolveReferences?: boolean },
    ): Promise<{ data: T; path: string } | null> => {
      assertBuildPhase('readByUrlPath')
      return buildCtx.readByUrlPath<T>(urlPath, options)
    },
  }
}

export interface NextCanopyContextResult {
  /** Request-scoped context. Uses headers() + React cache(). Call from server components and route handlers. */
  getCanopy: () => Promise<CanopyContext>
  /**
   * Build-time context. Uses STATIC_DEPLOY_USER (full admin, no auth), no request scope needed.
   * Safe to call from generateStaticParams, generateMetadata, sitemap, and build-time page rendering.
   * Memoized for the process lifetime — multiple calls return the same context.
   *
   * Returns a narrower type than getCanopy() (no `user`) but includes read/readByUrlPath so build-time
   * code can resolve a single entry by path/URL without scanning the whole collection.
   *
   * **Security note:** This context bypasses all branch and path ACLs (synthetic admin, unrestricted
   * read). Use it ONLY in build-time code paths not exposed to end users. On a `server` deployment its
   * operations throw if invoked at request time (where getCanopy() would enforce ACLs); prefer the
   * phase-selecting `readByUrlPath`/`read` below for page resolution.
   */
  getCanopyForBuild: () => Promise<CanopyBuildContext>
  /**
   * Phase-selecting `readByUrlPath`. At build time (isBuildMode()) it reads filesystem-direct via the
   * build context; at request time it uses the branch-aware, ACL-enforced runtime context (getCanopy()).
   *
   * This is the recommended way to resolve a page by URL in a `[...slug]`/`[slug]` route: correct in
   * both phases by construction (working tree at build, branch-clone preview in dev), so page code
   * never has to hand-pick the admin build context. Returns null for non-matching/invalid paths.
   */
  readByUrlPath: CanopyContext['readByUrlPath']
  /** Phase-selecting `read` (build context at build, runtime context at request) — counterpart to readByUrlPath. */
  read: CanopyContext['read']
  /** API catch-all route handler */
  handler: ReturnType<typeof createCanopyCatchAllHandler>
  /** Underlying services (rarely needed directly) */
  services: CanopyServices
}

/**
 * Create Next.js-specific wrapper around core context.
 * Adds React cache() for per-request memoization and API handler.
 * This function is async because it needs to load .collection.json meta files.
 *
 * In prod/dev mode, if the provided authPlugin implements verifyTokenOnly(),
 * it is automatically wrapped with CachingAuthPlugin + FileBasedAuthCache so that
 * auth works without network access (Lambda in prod, local in dev). The cache is populated by the worker daemon.
 */
export async function createNextCanopyContext(
  options: NextCanopyOptions,
): Promise<NextCanopyContextResult> {
  // Fail fast: authPlugin is required for server deployments
  if (options.config.deployedAs !== 'static' && !options.authPlugin) {
    throw new Error(
      'CanopyCMS: authPlugin is required when deployedAs is "server". ' +
        'Set deployedAs: "static" in your canopy config, or provide an authPlugin.',
    )
  }

  // Warn when running in static deployment mode so it is not accidentally set in a server build
  if (options.config.deployedAs === 'static' && !warnedStaticMode) {
    console.warn(
      'CanopyCMS: running in static deployment mode — all CMS API requests will return 401. ' +
        'Do not set deployedAs: "static" in a server deployment.',
    )
    warnedStaticMode = true
  }

  // Resolve the auth plugin: auto-wrap with CachingAuthPlugin for prod/dev when
  // the plugin supports token-only verification. This keeps auth networkless (required for
  // Lambda in prod, consistent in dev) without exposing caching internals to adopters.
  // For static deployments, use the stub that returns 401 for all requests.
  const { mode } = options.config
  const authPlugin: AuthPlugin = (() => {
    if (!options.authPlugin) return staticDeployAuthPlugin
    if ((mode === 'prod' || mode === 'dev') && options.authPlugin.verifyTokenOnly) {
      const cachePath =
        process.env.CANOPY_AUTH_CACHE_PATH ??
        path.join(operatingStrategy(mode).getWorkspaceRoot(), '.cache')
      // In dev mode, provide a lazy refresher so the cache is auto-populated
      // on first request without requiring manual `worker run-once`.
      const lazyRefresher =
        mode === 'dev' && options.authPlugin.createCacheRefresher
          ? options.authPlugin.createCacheRefresher(cachePath)
          : undefined
      return new CachingAuthPlugin(
        (ctx) => options.authPlugin!.verifyTokenOnly!(ctx),
        new FileBasedAuthCache(cachePath),
        lazyRefresher,
      )
    }
    return options.authPlugin
  })()

  // Create services ONCE at initialization
  const services = await createCanopyServices(options.config, {
    entrySchemaRegistry: options.entrySchemaRegistry,
  })

  // In dev, surface (or auto-fix) divergence between working-tree content and the served branch clone.
  // All logic lives in the core watcher; this is just the once-at-startup trigger (thin Next wiring).
  if (options.config.mode === 'dev' && !isBuildMode()) {
    startDevContentWatcher(services, { mode: options.config.dev?.contentSync })
  }

  // User extractor: passes Next.js headers to auth plugin, loads internal groups, applies authorization
  const extractUser = async (): Promise<CanopyUser> => {
    const headersList = await headers()
    const authResult = await authPlugin.authenticate(headersList)

    // Load internal groups from main branch
    const baseBranch = services.config.defaultBaseBranch ?? 'main'
    const operatingMode = services.config.mode ?? 'dev'
    const mainBranchContext = await loadBranchContext({
      branchName: baseBranch,
      mode: operatingMode,
    })
    const internalGroups: InternalGroup[] = mainBranchContext
      ? await loadInternalGroups(
          mainBranchContext.branchRoot,
          operatingMode,
          services.bootstrapAdminIds,
        ).catch((err: unknown) => {
          console.warn('CanopyCMS: Failed to load internal groups from main branch:', err)
          return [] as InternalGroup[]
        })
      : []

    if (!warnedNoAdmins && Array.isArray(internalGroups)) {
      const adminsGroup = internalGroups.find((g) => g.id === 'Admins')
      if (!adminsGroup || adminsGroup.members.length === 0) {
        console.warn(
          'CanopyCMS: No admin users configured. Set CANOPY_BOOTSTRAP_ADMIN_IDS or add members to the Admins group.',
        )
      }
      warnedNoAdmins = true
    }

    return authResultToCanopyUser(authResult, services.bootstrapAdminIds, internalGroups)
  }

  // Create core context with pre-created services (framework-agnostic)
  const coreContext = createCanopyContext({
    services,
    extractUser,
  })

  // Wrap with React cache() for per-request caching
  const getCanopy = cache((): Promise<CanopyContext> => {
    return coreContext.getContext()
  })

  // Build-time context: uses STATIC_DEPLOY_USER, no headers() call.
  // Safe for generateStaticParams, generateMetadata, and other non-request-scoped contexts.
  const buildContext = createCanopyContext({
    services,
    extractUser: async () => STATIC_DEPLOY_USER,
  })

  let buildContextPromise: Promise<CanopyBuildContext> | null = null
  const getCanopyForBuild = (): Promise<CanopyBuildContext> => {
    if (!buildContextPromise) {
      buildContextPromise = buildContext
        .getContext()
        .then(
          ({ buildContentTree, listEntries, read, readByUrlPath, services }): CanopyBuildContext =>
            // Guard so these reads throw if used at request time on a `server` deployment.
            guardBuildContext(
              { buildContentTree, listEntries, read, readByUrlPath, services },
              options.config,
            ),
        )
        .catch((err) => {
          buildContextPromise = null
          throw err
        })
    }
    return buildContextPromise
  }

  // Phase-selecting helpers: build context during static generation, branch-aware runtime at request
  // time. Lets page code resolve content without hand-picking the admin build context (see item #5).
  const readByUrlPath: CanopyContext['readByUrlPath'] = async <T = unknown>(
    urlPath: string,
    opts?: { branch?: string; resolveReferences?: boolean },
  ) => {
    const ctx = isBuildMode() ? await getCanopyForBuild() : await getCanopy()
    return ctx.readByUrlPath<T>(urlPath, opts)
  }
  const read: CanopyContext['read'] = async <T = unknown>(input: {
    entryPath: string
    slug?: string
    branch?: string
    resolveReferences?: boolean
  }) => {
    const ctx = isBuildMode() ? await getCanopyForBuild() : await getCanopy()
    return ctx.read<T>(input)
  }

  // Create API handler using same services
  const handler = createCanopyCatchAllHandler({
    ...options,
    authPlugin,
    services,
  })

  return {
    getCanopy,
    getCanopyForBuild,
    readByUrlPath,
    read,
    handler,
    services,
  }
}
