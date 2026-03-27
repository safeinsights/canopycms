import { createRequire } from 'node:module'
import path from 'node:path'
import type { NextConfig } from 'next'

/**
 * Canopy packages that need transpilation (they export raw TypeScript).
 */
const CANOPY_PACKAGES = [
  'canopycms',
  'canopycms-next',
  'canopycms-auth-clerk',
  'canopycms-auth-dev',
]

export interface WithCanopyOptions {
  /** Additional packages to transpile beyond the Canopy defaults. */
  packages?: string[]
}

/**
 * Resolve React modules from the consumer's project root rather than from
 * this package's location. This is critical when canopycms-next is installed
 * via `file:` symlinks — without it, `require.resolve('react')` would walk
 * up from the symlink target and find a different React copy.
 */
function resolveReactAliases(): Record<string, string> | null {
  try {
    const resolve = createRequire(path.join(process.cwd(), 'noop.js')).resolve
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
 * - Adds all Canopy packages to `transpilePackages` (they export raw TypeScript)
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
  // Merge transpilePackages (deduped)
  const existingPackages = nextConfig.transpilePackages ?? []
  const allPackages = [
    ...new Set([...existingPackages, ...CANOPY_PACKAGES, ...(options.packages ?? [])]),
  ]

  const reactAlias = resolveReactAliases()

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

  return {
    ...nextConfig,
    transpilePackages: allPackages,
    webpack,
  }
}
