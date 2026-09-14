import { createRequire } from 'node:module'
import path from 'node:path'
import type { NextConfig } from 'next'
import { hasNextConfig, installedNextMajor, sharpTracingIncludes } from './sharp-tracing'

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
const SAFE_BUILD_ID = /^[A-Za-z0-9._-]{1,255}$/

/** The message every rejection uses, so the stated rule and the enforced rule cannot drift. */
const BUILD_ID_RULE = 'must be 1-255 characters of [A-Za-z0-9._-] and not "." or ".."'

function isUsableBuildId(value: string): boolean {
  // `.` and `..` clear the character class but are not names — as a path segment they resolve to
  // the static directory itself or its parent. `a..b` is an ordinary filename and stays allowed.
  // The 255 bound is the same rule: a longer segment fails at `mkdir` with ENAMETOOLONG.
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
        `segment under _next/static/, so it ${BUILD_ID_RULE}. Using Next's random ` +
        'build id instead; this export is NOT reproducible.',
    )
    return null
  }

  return trimmed
}

/** Next's `outputFileTracingIncludes` shape: a route glob mapped to project-relative file globs. */
type TracingIncludes = Record<string, string[]>

/**
 * Every route. Both tracers match include keys as a "contains" glob against the route:
 * - Turbopack against "/" plus the page name (`crates/next-api/src/nft_json.rs` lines 56 and 312 at
 *   v16.1.7);
 * - the JS tracer through picomatch with `contains: true` (`next/dist/build/collect-build-traces.js`
 *   lines 464 and 475 in 16.1.7).
 */
const ALL_ROUTES = '/**'

function isTracingIncludes(value: unknown): value is TracingIncludes {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every(
      (globs: unknown) =>
        Array.isArray(globs) && globs.every((g: unknown) => typeof g === 'string'),
    )
  )
}

/** `value[key]` for any object, else undefined: for config keys Next's types no longer declare. */
function readProperty(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Whether Next treats a config value as set.
 *
 * `assignDefaults` in `next/dist/server/config.js` (`assignDefaultsAndValidate` in 16.1.7) drops
 * `undefined` and `null` values before it migrates legacy keys. That covers top-level keys and, for
 * object options such as `experimental`, their direct keys. It does not cover Next 15's
 * `experimental.turbo` merge, which runs on the raw config earlier.
 */
function isSet(value: unknown): boolean {
  return value !== undefined && value !== null
}

/** `includes` added under `'/**'`, deduped. Every entry the adopter already wrote is kept as written. */
function mergeTracingIncludes(
  existing: TracingIncludes | undefined,
  includes: string[],
): TracingIncludes {
  return {
    ...existing,
    [ALL_ROUTES]: [...new Set([...(existing?.[ALL_ROUTES] ?? []), ...includes])],
  }
}

function sharpTracingWarning(problem: string | undefined, nextVersionUnknown: boolean): string {
  return (
    "CanopyCMS: could not add sharp's libvips to this standalone build's file tracing" +
    (problem ? ` (${problem})` : '') +
    '. Next.js file tracing can miss that library for sharp 0.35 ' +
    '(https://github.com/vercel/next.js/issues/97973), and the built server then fails to load ' +
    'sharp with ERR_DLOPEN_FAILED. Add it in next.config yourself, with paths relative to the ' +
    "project directory. For pnpm: outputFileTracingIncludes: { '/**': " +
    "['node_modules/.pnpm/@img+sharp-libvips-*/node_modules/@img/*/lib/**/*'] }. For npm: " +
    "outputFileTracingIncludes: { '/**': ['node_modules/@img/sharp-libvips-*/lib/**/*'] }." +
    (nextVersionUnknown
      ? ' The installed Next.js version could not be read either: on Next 13 or 14, put ' +
        'outputFileTracingIncludes under experimental.'
      : '')
  )
}

/**
 * The warning for an include that WAS written, under a key chosen without knowing the Next version.
 *
 * That choice is always the top-level key. Next 13 and 14 ignore it, because their config schema
 * declares the option only under `experimental` (`server/config-schema.ts` line 311 in 14.2.25).
 */
function unknownNextVersionWarning(projectDir: string): string {
  return (
    `CanopyCMS: could not read the version of the next package installed for ${projectDir}, so ` +
    "sharp's libvips was added to the top-level outputFileTracingIncludes key, which Next 15 and " +
    'later read. Next 13 and 14 ignore that key: on those versions, move the entry under ' +
    'experimental.outputFileTracingIncludes.'
  )
}

/**
 * A Turbopack build evaluates the config in the main process and again in a worker thread with its
 * own module registry (`next/dist/build/turbopack-build/index.js:26` and `impl.js:209` in 16.1.7).
 * So "once" means once per process or thread, not once per build.
 */
let warnedAboutSharpTracing = false

/**
 * The config keys that make a Turbopack `output: 'standalone'` server able to load sharp.
 *
 * The rules live in `./sharp-tracing`. This function decides only whether to apply them, and under
 * which key.
 */
function sharpTracingConfig(
  nextConfig: NextConfig,
  options: WithCanopyOptions,
): Pick<NextConfig, 'outputFileTracingIncludes' | 'experimental'> {
  // A static export has no server, so there is nothing to trace for.
  if (options.staticBuild || nextConfig.output === 'export') return {}

  const projectDir = process.cwd()
  const nextMajor = installedNextMajor(projectDir)
  // May not be an object in an untyped config (`experimental: true` loads fine in Next), which is why
  // every read of it below goes through `readProperty`, never an `in` check.
  const experimental = nextConfig.experimental ?? {}

  // Read and write each option where Next reads it (`loadConfig` in `next/dist/server/config.js`).
  // A legacy `experimental` value of `undefined` or `null` counts as unset, because Next drops those
  // before migrating legacy keys (see `isSet`).
  // - Next 13 and 14 read the tracing options only under `experimental`.
  //   - A top-level key is reported as an invalid option and ignored. Their config schema is a
  //     strict object, and only `images` errors stop the build (`server/config.ts:84-90` in 14.2.25).
  //   - A root nobody configured comes from the CLOSEST lockfile there (`findRootDir`, called from
  //     `assignDefaults`), not the outermost.
  // - Next 15 and 16 still accept the `experimental` spellings, and copy any that is set over the
  //   top-level key (`warnOptionHasBeenMovedOutOfExperimental`, `config.js:542-544` in 16.1.7 and
  //   `:546-548` in 15.5.21). So a legacy value wins, and an include written only at the top level
  //   would be silently replaced.
  // - Only Next 15 merges `experimental.turbo` into `turbopack`, as `{ ...turbo, ...turbopack }`
  //   (`config.js:1190` in 15.5.21). Any `root` key on `turbopack` therefore wins, even an empty one.
  const experimentalOnly = nextMajor !== null && nextMajor < 15
  const includesUnderExperimental =
    experimentalOnly || isSet(readProperty(experimental, 'outputFileTracingIncludes'))
  const rootUnderExperimental =
    experimentalOnly || isSet(readProperty(experimental, 'outputFileTracingRoot'))

  const writtenIncludes: unknown = includesUnderExperimental
    ? readProperty(experimental, 'outputFileTracingIncludes')
    : nextConfig.outputFileTracingIncludes
  const existing = isSet(writtenIncludes) ? writtenIncludes : undefined
  // A malformed value is Next's to reject. Merging into it could only turn that into a crash here.
  if (existing !== undefined && !isTracingIncludes(existing)) return {}

  const configuredRoot = stringOrUndefined(
    rootUnderExperimental
      ? readProperty(experimental, 'outputFileTracingRoot')
      : nextConfig.outputFileTracingRoot,
  )
  const turbopack: unknown = nextConfig.turbopack
  const turbopackHasRootKey =
    typeof turbopack === 'object' && turbopack !== null && 'root' in turbopack
  const legacyTurbopackRoot =
    nextMajor === 15 && !turbopackHasRootKey
      ? stringOrUndefined(readProperty(readProperty(experimental, 'turbo'), 'root'))
      : undefined
  const turbopackRoot = experimentalOnly
    ? undefined
    : (stringOrUndefined(readProperty(turbopack, 'root')) ?? legacyTurbopackRoot)

  // Next never changes directory for `next build <dir>`: in 16.1.7 its only `process.chdir` is in
  // the generated standalone `server.js` (`next/dist/build/utils.js:1111`). So a working directory
  // with no config file in it is not the project, and any glob computed relative to it would be
  // wrong.
  const { includes, problem } = hasNextConfig(projectDir)
    ? sharpTracingIncludes({
        projectDir,
        outputFileTracingRoot: configuredRoot,
        turbopackRoot,
        lockfileRoot: experimentalOnly ? 'closest' : 'outermost',
      })
    : {
        includes: [],
        problem: `the working directory ${projectDir} has no next.config file, so withCanopy cannot tell where the project is`,
      }

  const nextVersionUnknown = nextMajor === null
  if (includes.length === 0) {
    if (nextConfig.output === 'standalone' && !warnedAboutSharpTracing) {
      warnedAboutSharpTracing = true
      console.warn(sharpTracingWarning(problem, nextVersionUnknown))
    }
    return {}
  }

  const merged = mergeTracingIncludes(existing, includes)
  if (!includesUnderExperimental) {
    // An unreadable version falls back to the key Next 15 and later read. A standalone build says
    // so: Next 13 and 14 ignore that key, so libvips would not be traced.
    if (nextVersionUnknown && nextConfig.output === 'standalone' && !warnedAboutSharpTracing) {
      warnedAboutSharpTracing = true
      console.warn(unknownNextVersionWarning(projectDir))
    }
    return { outputFileTracingIncludes: merged }
  }
  // Built as a variable, not returned as a literal, because Next 15's `ExperimentalConfig` type no
  // longer declares this key.
  const legacyExperimental = { ...experimental, outputFileTracingIncludes: merged }
  return { experimental: legacyExperimental }
}

/**
 * Wrap your Next.js config for CanopyCMS: module transpilation and React resolution. Always
 * recommended — replaces manual `transpilePackages` config and is harmless without aliases.
 *
 * **What it does:**
 * - Adds installed Canopy packages to `transpilePackages` (they export raw TypeScript), auto-detected
 *   so an optional package you haven't installed is never added.
 * - Adds `server.ts`/`server.tsx` (or, with `staticBuild: true`, `static.ts`/`static.tsx`) to
 *   `pageExtensions`, so CMS-only files build in dev/CMS and static-only variants build instead.
 * - Resolves React to one copy from your project root, avoiding "Invalid hook call" crashes when
 *   canopycms packages are linked via `file:`/`npm link` (the bundler would otherwise follow the
 *   symlink to a second React copy); a no-op otherwise, since it resolves to the React you already use.
 * - With `staticBuild: true`, honors `CANOPY_BUILD_ID` as a reproducible build id (Next
 *   defaults to a random one); unset, or off a static build, Next's default stands.
 * - Outside a static export, adds sharp's libvips directory to `outputFileTracingIncludes['/**']`
 *   (kept under `experimental` on Next 13/14 or legacy spellings; your own includes stay), so a
 *   Turbopack `output: 'standalone'` server can load sharp — Next's tracing misses that library
 *   for sharp 0.35 (doesn't fix webpack builds); warns if the directory or version can't be found.
 * - On Next 16+, sets `turbopack: {}` when your config has neither `turbopack` nor `webpack` and
 *   the Next version can be read — Next 16 defaults to Turbopack and exits when a config exports
 *   `webpack` (the React aliases above add one) with no `turbopack` key; a `turbopack` you set is
 *   left alone.
 *
 * @example
 * ```ts
 * import { withCanopy } from 'canopycms-next/config'
 * export default withCanopy({ reactStrictMode: true })
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

  // Next 16 defaults both `next build` and `next dev` to Turbopack, marking the default with
  // `TURBOPACK=auto` (`next/dist/lib/bundler.js:76`), and then exits with "This build is using
  // Turbopack, with a `webpack` config and no `turbopack` config" whenever the exported config's
  // `webpack` is truthy, its `turbopack` is not, and it has no `experimental.turbo*` key
  // (`validateTurboNextConfig` in `next/dist/lib/turbopack-warning.js:137-138` and `:158-174`,
  // 16.1.7).
  //
  // The `webpack` function above is withCanopy's own, and Turbopack never runs a `webpack`
  // function, so its React aliases never applied under Turbopack. That is why the NOTE above sends
  // `file:` symlink installs to `next dev --webpack`, and why answering the guard with an empty
  // `turbopack` object is safe for this function. The rules:
  // - Only when withCanopy added that function and the adopter wrote no `webpack` of their own.
  //   For theirs, Next's guard is the right one.
  // - Never over a `turbopack` the adopter set, so a config that already has `turbopack: {}` keeps
  //   its own value.
  // - Only on a detected Next 16 or later. Next 15 only warns here (`turbopack-warning.js:172-175`,
  //   15.5.21), and Next 13 and 14 report an unknown top-level `turbopack` as an invalid option
  //   (their config schema is a strict object with no such key), so an unreadable version gets no
  //   key.
  const nextMajor = installedNextMajor(process.cwd())
  const answerTurbopackGuard =
    webpack !== undefined &&
    !isSet(existingWebpack) &&
    !isSet(nextConfig.turbopack) &&
    nextMajor !== null &&
    nextMajor >= 16

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
  // `resolveStaticBuildId` (above) holds the rules for reading the variable and why each exists.
  // One rule lives here instead, because it constrains this line rather than that function:
  // returning the resolver's string directly matters. Next re-rolls ids containing `ad`
  // (ad-blocker false positives) only on the `null` fallback path — a returned string is used
  // verbatim (`next/dist/build/generate-build-id.js`) — which is what makes a hex tree hash usable
  // as a build id at all. Do not "helpfully" route this through the fallback.
  const generateBuildId =
    nextConfig.generateBuildId ?? (options.staticBuild ? resolveStaticBuildId : undefined)

  return {
    ...nextConfig,
    transpilePackages: allPackages,
    pageExtensions,
    webpack,
    rewrites: withAssetsRewrite(nextConfig.rewrites),
    ...sharpTracingConfig(nextConfig, options),
    // Spread conditionally: emitting `generateBuildId: undefined` would be a key Next has to
    // reason about, where absence is unambiguous.
    ...(generateBuildId ? { generateBuildId } : {}),
    ...(answerTurbopackGuard ? { turbopack: {} } : {}),
  }
}
