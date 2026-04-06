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
 * Next.js default pageExtensions. Not exported as a public API by Next.js
 * (only available via internal `next/dist/server/config-shared`), so we
 * mirror them here. Must be kept in sync manually if Next.js changes defaults.
 * As of Next.js 15.x these are: tsx, ts, jsx, js.
 */
const NEXTJS_DEFAULT_PAGE_EXTENSIONS = ['tsx', 'ts', 'jsx', 'js']

export interface WithCanopyOptions {
  /** Additional packages to transpile beyond the Canopy defaults. */
  packages?: string[]
  /**
   * Set to `true` for static export builds to exclude CMS-only pages.
   *
   * When `false` (default): adds `server.ts` and `server.tsx` to `pageExtensions`,
   * so Next.js processes `.server.ts` and `.server.tsx` files (API routes, editor page).
   *
   * When `true`: leaves them out, so Next.js ignores CMS-only files during static export.
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
 * Wrap your Next.js config to set up module transpilation and React
 * resolution for CanopyCMS packages.
 *
 * **What it does:**
 * - Auto-detects installed Canopy packages and adds them to `transpilePackages`
 *   (they export raw TypeScript). Only packages found in your node_modules are
 *   added, so you don't need to worry about optional packages you haven't installed.
 * - Adds `server.ts`/`server.tsx` to `pageExtensions` for dual-build support.
 *   CMS-only files (e.g., `route.server.ts`) are included in dev/CMS builds
 *   but excluded when `staticBuild: true` is set.
 * - Resolves React to a single copy from your project root, preventing
 *   dual-instance crashes when using `file:` symlinks for local development
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
 * import { withCanopy } from 'canopycms-next'
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

  // Dual-build support: include CMS-only page extensions unless this is a static build.
  // Files like `route.server.ts` and `page.server.tsx` are only processed when
  // CMS_PAGE_EXTENSIONS are in pageExtensions.
  const pageExtensions = options.staticBuild
    ? nextConfig.pageExtensions // static build: don't add CMS extensions
    : [...(nextConfig.pageExtensions ?? NEXTJS_DEFAULT_PAGE_EXTENSIONS), ...CMS_PAGE_EXTENSIONS]

  return {
    ...nextConfig,
    transpilePackages: allPackages,
    ...(pageExtensions ? { pageExtensions } : {}),
    webpack,
  }
}
