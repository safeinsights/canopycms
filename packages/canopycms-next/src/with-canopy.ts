import { createRequire } from 'node:module'
import path from 'node:path'
import type { NextConfig } from 'next'

/** The core package — always required when using withCanopy. */
const REQUIRED_PACKAGES = ['canopycms']

/**
 * Canopy packages that need transpilation when installed.
 * Not every adopter installs all of these (e.g., only one auth plugin,
 * CDK only for AWS deployments). Including an uninstalled package in
 * `transpilePackages` causes Next.js build errors, so we auto-detect.
 */
const OPTIONAL_PACKAGES = [
  'canopycms-next',
  'canopycms-auth-clerk',
  'canopycms-auth-dev',
  'canopycms-cdk',
]

/**
 * CMS-only page extensions used by the dual-build convention.
 * Files with these extensions (e.g., `route.server.ts`, `page.server.tsx`)
 * are included in dev/CMS builds but excluded from static export builds.
 */
const CMS_PAGE_EXTENSIONS = ['server.ts', 'server.tsx']

/**
 * Static-export-only page extensions used by the dual-build convention.
 * Files with these extensions (e.g., `page.static.tsx`) are included only in
 * static export builds (`staticBuild: true`), letting a content route ship
 * per-build variants: `page.static.tsx` prerenders (with `dynamicParams =
 * false`, required by `output: 'export'`) while `page.server.tsx` renders
 * every request at request time (`dynamic = 'force-dynamic'`, no
 * generateStaticParams) so path ACLs apply and unknown slugs 404 instead of
 * throwing Next's internal NoFallbackError. Next statically parses
 * route-segment config, so a single shared page cannot switch these on an
 * env var.
 */
const STATIC_PAGE_EXTENSIONS = ['static.ts', 'static.tsx']

/**
 * Next.js default pageExtensions. Not exported as a public API by Next.js
 * (only available via internal `next/dist/server/config-shared`), so we
 * mirror them here. Must be kept in sync manually if Next.js changes defaults.
 * As of Next.js 15.x these are: tsx, ts, jsx, js.
 */
const NEXTJS_DEFAULT_PAGE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js']

/**
 * Maps CanopyCMS's public asset URL space onto the raw-serving API route.
 * `/assets/:path*` covers both static public objects (`assets/{hash}/{slug}.ext`
 * - sanitized svg/pdf) and transform outputs (`assets/t/{directives}/...`);
 * the destination re-adds the `assets/` prefix because that's the literal
 * store key the raw route (`GET /assets/raw/{key...}`) expects, and adds
 * `assets/raw/` because that's where the raw route itself is mounted.
 *
 * Harmless for static export (no server ever consults `rewrites` there) and
 * correct under `next dev`/server mode.
 */
const ASSETS_REWRITE = {
  source: '/assets/:path*',
  destination: '/api/canopycms/assets/raw/assets/:path*',
}

/**
 * Wrap a user's existing `rewrites` config (if any) to also add
 * `ASSETS_REWRITE`, handling every shape Next.js allows:
 * - no `rewrites` at all
 * - the plain-array form (checked after filesystem routes/public, before
 *   dynamic routes - i.e. equivalent to the object form's `afterFiles`)
 * - the `{ beforeFiles, afterFiles, fallback }` object form (any bucket
 *   optional) - CanopyCMS's rule is added to `afterFiles`, matching the
 *   plain-array form's placement semantics
 *
 * Next's own `NextConfig['rewrites']` type requires the function to return
 * a `Promise`, but plain (non-async) user functions that just return the
 * value directly are common in real `next.config.js` files (untyped JS) -
 * `await`ing a non-Promise value resolves immediately, so this handles both
 * without assuming the user's function is itself async.
 */
function withAssetsRewrite(
  existingRewrites: NextConfig['rewrites'],
): NonNullable<NextConfig['rewrites']> {
  return async () => {
    if (!existingRewrites) {
      return [ASSETS_REWRITE]
    }

    const result = await existingRewrites()
    if (Array.isArray(result)) {
      return [...result, ASSETS_REWRITE]
    }

    return {
      beforeFiles: result.beforeFiles ?? [],
      afterFiles: [...(result.afterFiles ?? []), ASSETS_REWRITE],
      fallback: result.fallback ?? [],
    }
  }
}

export interface WithCanopyOptions {
  /** Additional packages to transpile beyond the Canopy defaults. */
  packages?: string[]
  /**
   * Set to `true` for static export builds to exclude CMS-only pages.
   *
   * When `false` (default): adds `server.ts` and `server.tsx` to `pageExtensions`,
   * so Next.js processes `.server.ts` and `.server.tsx` files (API routes, editor page,
   * and the server-build variant of a dual-build content route).
   *
   * When `true`: adds `static.ts` and `static.tsx` to `pageExtensions` instead, so
   * Next.js processes the static-export-only variant of a dual-build content route
   * (e.g. `page.static.tsx`) while ignoring `.server.*` CMS-only files. It also lets
   * `CANOPY_BUILD_ID` pin Next's build id, so a content-addressed artifact is reproducible.
   *
   * @example
   * ```ts
   * const isCmsBuild = process.env.CANOPY_BUILD === 'cms'
   * export default withCanopy({}, { staticBuild: !isCmsBuild })
   * ```
   */
  staticBuild?: boolean
}

/**
 * Resolve React modules from the consumer's project root rather than from
 * this package's location. This is critical when canopycms-next is installed
 * via `file:` symlinks — without it, `require.resolve('react')` would walk
 * up from the symlink target and find a different React copy.
 */
function resolveReactAliases(resolve: NodeRequire['resolve']): Record<string, string> | null {
  try {
    // Alias to DIRECTORIES, not files. Webpack uses prefix matching, so
    // aliasing `react` to a directory lets `react/jsx-runtime` resolve
    // to `<dir>/jsx-runtime` naturally. Pointing to a file (index.js)
    // would break subpath resolution (e.g. react/index.js/jsx-runtime).
    return {
      react: path.dirname(resolve('react')),
      'react-dom': path.dirname(resolve('react-dom')),
    }
  } catch {
    // If resolution fails (unusual environment), skip aliases.
    // transpilePackages alone may suffice.
    return null
  }
}

/**
 * A build id Next can safely use as a single path segment.
 *
 * Next applies NO validation: `generateBuildId`'s return is trimmed and interpolated straight
 * into `out/_next/static/<id>/`. So `CANOPY_BUILD_ID=$(git describe --all)` yields `heads/main`
 * and silently nests that directory one level deeper than every emitted URL expects, and a value
 * containing `..` climbs out of it. Both are the adopter's own pipeline misfiring rather than an
 * injection vector, which is exactly why a clear message beats a broken deploy.
 */
const SAFE_BUILD_ID = /^[A-Za-z0-9._-]+$/

function isUsableBuildId(value: string): boolean {
  // `.` and `..` clear the character class but are not names — as a path segment they resolve to
  // the static directory itself or its parent. `a..b` is an ordinary filename and stays allowed.
  return SAFE_BUILD_ID.test(value) && value !== '.' && value !== '..'
}

/**
 * Resolve Next's build id from `CANOPY_BUILD_ID`, or `null` to keep Next's random default.
 *
 * Both rejections warn rather than passing the value through or throwing. Unset means "I did not
 * ask for a reproducible build" and says nothing; set-but-unusable almost always means a pipeline
 * computed the id and the command failed (`CANOPY_BUILD_ID=$(git rev-parse ...)`), so the adopter
 * believes they pinned it and would otherwise get a random — or structurally broken — artifact
 * with nothing said. Falling back to Next's default keeps the build working; it is only the
 * reproducibility that is lost, and the warning is what makes that recoverable.
 *
 * Declared above `withCanopy` deliberately: sitting between that function and its JSDoc block
 * orphans the block onto this one, and the shipped `dist/config.d.ts` loses every line of
 * `withCanopy`'s adopter-facing documentation.
 */
function resolveStaticBuildId(): string | null {
  const raw = process.env.CANOPY_BUILD_ID
  const trimmed = raw?.trim()
  if (raw === undefined) return null

  if (!trimmed) {
    console.warn(
      "CanopyCMS: CANOPY_BUILD_ID is set but blank — using Next's random build id instead. " +
        'This export is NOT reproducible; two builds of one source tree will differ.',
    )
    return null
  }

  if (!isUsableBuildId(trimmed)) {
    console.warn(
      `CanopyCMS: ignoring CANOPY_BUILD_ID="${trimmed}" — a build id becomes a single path ` +
        'segment under _next/static/, so it must match [A-Za-z0-9._-]+. Using Next’s random ' +
        'build id instead; this export is NOT reproducible.',
    )
    return null
  }

  return trimmed
}

/**
 * Wrap your Next.js config to set up module transpilation and React
 * resolution for CanopyCMS packages.
 *
 * **What it does:**
 * - Auto-detects installed Canopy packages and adds them to `transpilePackages`
 *   (they export raw TypeScript). Only packages found in your node_modules are
 *   added, so you don't need to worry about optional packages you haven't installed.
 * - Adds `server.ts`/`server.tsx` (or, when `staticBuild: true`, `static.ts`/`static.tsx`)
 *   to `pageExtensions` for dual-build support. CMS-only files (e.g., `route.server.ts`)
 *   are included in dev/CMS builds but excluded when `staticBuild: true` is set, in favor
 *   of the static-export-only page variants (e.g. `page.static.tsx`).
 * - Resolves React to a single copy from your project root, preventing
 *   dual-instance crashes when using `file:` symlinks for local development
 * - With `staticBuild: true`, honors `CANOPY_BUILD_ID` as Next's build id (Next's default is
 *   random, which puts two builds of one source tree in different `_next/static/` directories).
 *   Unset, or on a non-static build, Next's default is used unchanged.
 *
 * **When you need this:**
 * - Always recommended — it replaces manual `transpilePackages` configuration
 *   and is harmless when React aliases aren't strictly needed.
 *
 * **When React aliases matter:**
 * - When consuming canopycms packages via `file:` references or `npm link`
 *   during local development. Without the aliases, the bundler follows
 *   symlinks and may resolve a second copy of React from the linked
 *   package's node_modules, causing "Invalid hook call" crashes.
 * - When installing from npm (not symlinked), the aliases are still safe
 *   — they simply resolve to the same React your project already uses.
 *
 * @example
 * ```ts
 * // next.config.ts
 * import { withCanopy } from 'canopycms-next/config'
 *
 * export default withCanopy({
 *   reactStrictMode: true,
 *   // ...your config
 * })
 * ```
 */
export function withCanopy(
  nextConfig: NextConfig = {},
  options: WithCanopyOptions = {},
): NextConfig {
  const resolve = createRequire(path.join(process.cwd(), 'noop.js')).resolve
  const installedOptional = OPTIONAL_PACKAGES.filter((pkg) => {
    try {
      resolve(pkg)
      return true
    } catch {
      return false
    }
  })

  // Merge transpilePackages (deduped)
  const existingPackages = nextConfig.transpilePackages ?? []
  const allPackages = [
    ...new Set([
      ...existingPackages,
      ...REQUIRED_PACKAGES,
      ...installedOptional,
      ...(options.packages ?? []),
    ]),
  ]

  const reactAlias = resolveReactAliases(resolve)

  // Scope React aliases to only canopycms files using module.rules[].resolve.
  // A global resolve.alias would also override Next.js's own internal React
  // (bundled at next/dist/compiled/react/), breaking its devtools and internals.
  const existingWebpack = nextConfig.webpack
  const webpack: NextConfig['webpack'] = reactAlias
    ? (config, ctx) => {
        config.module = config.module ?? { rules: [] }
        config.module.rules = config.module.rules ?? []

        // Match canopycms source files by path (covers both symlink and real paths)
        config.module.rules.push({
          test: /\.(?:ts|tsx|js|jsx|mjs)$/,
          include: /[\\/]canopycms/,
          resolve: {
            alias: reactAlias,
          },
        })

        // Chain consumer's existing webpack config
        if (typeof existingWebpack === 'function') {
          return existingWebpack(config, ctx)
        }
        return config
      }
    : existingWebpack

  // NOTE: Turbopack's resolveAlias does not support absolute file paths —
  // it prepends './' and treats them as relative imports, which breaks.
  // Until Turbopack supports absolute path aliases, consumers using
  // file: symlinks must use `next dev --webpack` for local development.
  // Turbopack works fine when canopycms is installed from npm (no symlinks).

  // Dual-build support: a static build gets STATIC_PAGE_EXTENSIONS (e.g. `page.static.tsx`)
  // instead of CMS_PAGE_EXTENSIONS, so CMS-only files (`route.server.ts`, `page.server.tsx`)
  // are excluded from static export while the static-only page variants are included.
  // Set-dedupe guards against a consumer config that already lists any of the
  // canopy variant extensions (duplicates would be harmless to Next but noisy).
  const pageExtensions = [
    ...new Set([
      ...(nextConfig.pageExtensions ?? NEXTJS_DEFAULT_PAGE_EXTENSIONS),
      ...(options.staticBuild ? STATIC_PAGE_EXTENSIONS : CMS_PAGE_EXTENSIONS),
    ]),
  ]

  // Static exports are routinely content-addressed (an S3/CloudFront artifact keyed on a tree
  // hash), and Next defaults `generateBuildId` to `nanoid()` — so two builds of one source tree
  // land under different `out/_next/static/<id>/` directories and the id names two different file
  // sets. An explicit `generateBuildId` in the host config always wins.
  //
  // Deliberately gated on `staticBuild`. Under the dual-build convention the two flavors have
  // different `pageExtensions` and therefore different chunk sets; pinning both from one env var
  // would give two different file sets the SAME `_next/static/<id>/` path, which nothing can route
  // between if they ever share an origin. The CMS build keeps nanoid so the ids stay distinct.
  //
  // Two details that look like style choices and are not:
  // - `.trim()` then `||`, not `??`. An empty-string env var survives `??`, then clears Next's
  //   `typeof buildId !== 'string'` guard and yields an EMPTY build id. `||` alone is still not
  //   enough: Next trims AFTER that guard (`return buildId.trim()`), so a whitespace-only value is
  //   truthy here, passes the guard, and lands as an empty id anyway. Trimming first also keeps
  //   this id byte-identical to the one the AI manifest records for the same artifact.
  // - Returning the string directly matters. Next re-rolls ids containing `ad` (ad-blocker false
  //   positives) only on the `null` fallback path — a returned string is used verbatim
  //   (`next/dist/build/generate-build-id.js`) — which is what makes a hex tree hash usable here.
  //   Do not "helpfully" route this through the fallback.
  const generateBuildId =
    nextConfig.generateBuildId ?? (options.staticBuild ? resolveStaticBuildId : undefined)

  return {
    ...nextConfig,
    transpilePackages: allPackages,
    pageExtensions,
    webpack,
    rewrites: withAssetsRewrite(nextConfig.rewrites),
    // Spread conditionally: emitting `generateBuildId: undefined` would be a key Next has to
    // reason about, where absence is unambiguous.
    ...(generateBuildId ? { generateBuildId } : {}),
  }
}
