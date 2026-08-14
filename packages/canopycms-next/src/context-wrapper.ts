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
  type DefaultEntryTypes,
  type ListEntriesOptions,
  type ListEntriesItem,
  createCanopyServices,
  createAssetStore,
  operatingStrategy,
  resolveCanopyUser,
  STATIC_DEPLOY_USER,
} from 'canopycms/server'
import type { CanopyConfig, AuthPlugin, CanopyUser, FieldConfig } from 'canopycms'
import { assertAuthPluginAllowedForMode } from 'canopycms/auth'
import { CachingAuthPlugin, FileBasedAuthCache } from 'canopycms/auth/cache'
import type { Metadata, MetadataRoute } from 'next'
import { createCanopyCatchAllHandler } from './adapter'
import {
  collectStaticParams,
  entryToMetadata,
  generateContentSitemap,
  type EntryToMetadataOptions,
  type GenerateContentSitemapOptions,
  type GenerateContentStaticParamsOptions,
} from './static'

let warnedStaticMode = false

/**
 * Stub auth plugin for static deployments where no real auth is needed.
 * Returns unauthenticated for all requests — API routes will return 401.
 *
 * `verifiesCredentials: true` is set here even though this plugin verifies nothing: it is an
 * always-deny stub (authenticate() unconditionally fails), so it trivially satisfies the prod
 * allowlist — it can never admit anyone. WITHOUT this marker, a mode: 'prod' + deployedAs:
 * 'static' build (the supported zero-editor public build, which has no authPlugin at all) would
 * throw at handler creation when assertAuthPluginAllowedForMode() runs against this stub.
 */
const staticDeployAuthPlugin: AuthPlugin = {
  verifiesCredentials: true,
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
 * Wrap a build context so its operations throw if misused at request time on a production server.
 *
 * The build context runs as a synthetic admin and bypasses all branch/path ACLs. At **prod-server
 * request time** there is never a legitimate reason to use it — a real user is on the other end, so
 * content must be read through the request-scoped, ACL-enforcing getCanopy() (or the phase-selecting
 * read/readByUrlPath, which routes to it at request time). So the guard fires for
 * `mode === 'prod' && deployedAs === 'server' && !isBuildMode()` and fails closed (throws) rather than
 * silently leaking protected content.
 *
 * Why not also in dev: Next invokes legitimate static-generation hooks (generateStaticParams,
 * generateMetadata) in `next dev` with the same `!isBuildMode()` signature as the footgun, and there
 * is no reliable way to tell them apart — a dev guard would false-positive on idiomatic code. In prod
 * that ambiguity is gone (generateStaticParams is build-only; request-time build-context use is the
 * footgun). Why not on `static` deployments: they skip ACLs everywhere by design, so there's nothing
 * to leak. `CANOPY_BUILD_MODE=true` marks non-Next static generation as build phase.
 */
export function guardBuildContext(
  buildCtx: CanopyBuildContext,
  config: CanopyConfig,
): CanopyBuildContext {
  const assertBuildPhase = (method: string): void => {
    if (config.mode === 'prod' && config.deployedAs === 'server' && !isBuildMode()) {
      throw new Error(
        `CanopyCMS: getCanopyForBuild().${method}() was called at request time on a production ` +
          "'server' deployment. The build context bypasses all branch and path ACLs and must only be " +
          'used during static generation (next build / CANOPY_BUILD_MODE=true). Use the request-scoped ' +
          'getCanopy(), or the phase-selecting read()/readByUrlPath() from createNextCanopyContext.',
      )
    }
  }
  return {
    services: buildCtx.services,
    buildContentTree: <T = unknown, TEntryTypes = DefaultEntryTypes>(
      options?: BuildContentTreeOptions<T, TEntryTypes>,
    ): Promise<ContentTreeNode<T>[]> => {
      assertBuildPhase('buildContentTree')
      return buildCtx.buildContentTree<T, TEntryTypes>(options)
    },
    listEntries: <T = Record<string, unknown>>(
      options?: ListEntriesOptions<T>,
    ): Promise<ListEntriesItem<T>[]> => {
      assertBuildPhase('listEntries')
      return buildCtx.listEntries<T>(options)
    },
    // Return types inferred from the core build context (which now carries
    // meta.physicalPath); the returned object is validated against CanopyBuildContext.
    read: <T = unknown>(input: {
      entryPath: string
      slug?: string
      branch?: string
      resolveReferences?: boolean
    }) => {
      assertBuildPhase('read')
      return buildCtx.read<T>(input)
    },
    readByUrlPath: <T = unknown>(
      urlPath: string,
      options?: { branch?: string; resolveReferences?: boolean },
    ) => {
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
   * read). It's an advanced escape hatch — for ordinary page work prefer the phase-selecting
   * `readByUrlPath`/`read` (content) and `generateContentStaticParams` (paths) below, which don't hand
   * the admin context to your page modules. On a production `server` deployment its operations throw
   * if invoked at request time (where getCanopy() would enforce ACLs).
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
  /**
   * Build the array Next's `generateStaticParams` expects from CanopyCMS content. Enumeration-only
   * (reads the set of routable paths, never entry content) and closes over the build context, so your
   * page module never imports the admin `getCanopyForBuild`. Use `{ rootPath, shape: 'single' }` for a
   * `[slug]` route, or the default catch-all for `[...slug]`.
   */
  generateContentStaticParams: (
    options?: GenerateContentStaticParamsOptions,
  ) => Promise<Array<Record<string, string | string[]>>>
  /**
   * Build `app/sitemap.ts`'s `MetadataRoute.Sitemap` from CanopyCMS content. Includes EVERY
   * routable entry type by default and excludes `noindex` entries through the same predicate
   * `entryToMetadata` uses for `robots`. Bound to the build context, so your `sitemap.ts` never
   * imports the admin `getCanopyForBuild`.
   */
  generateContentSitemap: (options: GenerateContentSitemapOptions) => Promise<MetadataRoute.Sitemap>
  /**
   * Map an entry's SEO fields onto a Next `Metadata` for `generateMetadata`. Re-exposed here so a
   * page module has one CanopyCMS import (your `lib/canopy.ts`) rather than two; it is a pure
   * mapping and touches no context.
   */
  entryToMetadata: (entryData: unknown, options?: EntryToMetadataOptions) => Metadata
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

  // Fail closed (SEC-C1): a dev/insecure auth plugin must never serve prod traffic.
  // Checked before any wrapping below — CachingAuthPlugin would otherwise hide the marker.
  if (options.authPlugin) {
    assertAuthPluginAllowedForMode(options.authPlugin, options.config.mode)
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
        { verifiesCredentials: options.authPlugin!.verifiesCredentials === true },
      )
    }
    return options.authPlugin
  })()

  // Create services ONCE at initialization
  const services = await createCanopyServices(options.config, {
    entrySchemaRegistry: options.entrySchemaRegistry,
  })

  // Fallback root for the implicit local asset store (media unset, or
  // adapter: 'local' without a directory). Dev-only by design: in prod an
  // unset `media` must leave the store unconfigured (asset routes 501)
  // rather than silently storing assets on EFS with no serving path in the
  // static build.
  const devAssetsDir =
    mode === 'dev' ? path.join(operatingStrategy(mode).getWorkspaceRoot(), 'assets') : undefined
  const assetStore = createAssetStore(options.config.media, { devAssetsDir })

  // In dev, surface divergence between working-tree content and the served branch clone (warn-only).
  // All logic lives in the core watcher; this is just the once-at-startup trigger (thin Next wiring).
  if (options.config.mode === 'dev' && !isBuildMode()) {
    startDevContentWatcher(services, { mode: options.config.dev?.contentSync })
  }

  // User extractor: passes Next.js headers to auth plugin, resolves internal
  // groups, applies authorization. Delegates to the shared
  // "authenticate -> load internal groups -> merge" pipeline
  // (resolveCanopyUser, in canopycms core) so this stays in lockstep with
  // http/handler.ts's API-layer equivalent rather than re-implementing it —
  // a previous copy here loaded groups from the base branch content clone
  // (via loadBranchContext), which nothing in the product ever writes
  // groups.json into, so group-based privileges never took effect.
  //
  // No base-branch context resolution here (unlike the previous copy):
  // that call existed only to source groups.json from the (wrong) content
  // branch. Actual content reads (buildContentTree/listEntries/read) already
  // provision the base/active branch themselves via loadOrCreateBranchContext
  // (see context.ts's resolveSchemaContext), so dropping it here removes a
  // redundant per-request EFS round-trip rather than losing provisioning.
  const extractUser = async (): Promise<CanopyUser> => {
    const headersList = await headers()
    const authResult = await authPlugin.authenticate(headersList)

    return resolveCanopyUser(authResult, {
      getSettingsBranchRoot: services.getSettingsBranchRoot,
      mode: services.config.mode ?? 'dev',
      bootstrapAdminIds: services.bootstrapAdminIds,
    })
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

  // Enumeration-only static-params helper, bound to the (guarded) build context so page modules don't
  // import the admin context just to list paths. generateStaticParams is build-only, so this is safe.
  const generateContentStaticParams = async (options: GenerateContentStaticParamsOptions = {}) => {
    return collectStaticParams(await getCanopyForBuild(), options)
  }

  // Sitemap generation reads entry CONTENT (to apply the noindex predicate), so unlike
  // generateContentStaticParams it is not enumeration-only — but sitemap.ts is build-only in a
  // static export, and on a prod `server` deployment guardBuildContext throws if it is reached at
  // request time. Binding it here keeps the admin context out of the route module either way.
  const boundGenerateContentSitemap = async (options: GenerateContentSitemapOptions) => {
    return generateContentSitemap(await getCanopyForBuild(), options)
  }

  // Create API handler using same services
  const handler = createCanopyCatchAllHandler({
    ...options,
    authPlugin,
    services,
    assetStore,
  })

  return {
    getCanopy,
    getCanopyForBuild,
    readByUrlPath,
    read,
    generateContentStaticParams,
    generateContentSitemap: boundGenerateContentSitemap,
    entryToMetadata,
    handler,
    services,
  }
}
