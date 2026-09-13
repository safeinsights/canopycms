import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { NextConfig } from 'next'

// Track which packages should be "uninstalled" for each test
let unresolvablePackages: string[] = []

// Mock node:module so we can control what require.resolve returns
vi.mock('node:module', () => ({
  createRequire: vi.fn(() => ({
    resolve: (id: string) => {
      if (unresolvablePackages.includes(id)) {
        throw new Error(`Cannot find module '${id}'`)
      }
      return `/mock/node_modules/${id.replace(/\//g, '_')}/index.js`
    },
  })),
}))

/**
 * `./sharp-tracing` has its own real-filesystem test suite (sharp-tracing.test.ts). Here it's
 * mocked to a controllable stub, driven by `tracing`, so withCanopy's own logic — which key to
 * write under, how to merge, when to warn — can be tested without touching the filesystem.
 * `vi.hoisted` is required because `vi.mock`'s factory is hoisted above these imports, so the
 * state and spies it closes over must be created inside that same hoisted call.
 */
const { tracing, sharpTracingIncludesMock, installedNextMajorMock, hasNextConfigMock } = vi.hoisted(
  () => {
    const tracing = {
      result: { includes: [] as string[], problem: undefined as string | undefined },
      nextMajor: 16 as number | null,
      hasConfig: true,
    }
    return {
      tracing,
      sharpTracingIncludesMock: vi.fn(() => tracing.result),
      installedNextMajorMock: vi.fn(() => tracing.nextMajor),
      hasNextConfigMock: vi.fn(() => tracing.hasConfig),
    }
  },
)

vi.mock('./sharp-tracing', () => ({
  sharpTracingIncludes: sharpTracingIncludesMock,
  installedNextMajor: installedNextMajorMock,
  hasNextConfig: hasNextConfigMock,
}))

import { withCanopy } from './with-canopy'

/** Helper to invoke the webpack function from a withCanopy result */
function invokeWebpack(config: NextConfig, webpackConfig: unknown) {
  const webpackFn = config.webpack as NonNullable<NextConfig['webpack']>
  return webpackFn(webpackConfig as any, {} as any)
}

/**
 * Builds a NextConfig from a value that would not type-check as one directly (e.g. a malformed
 * `outputFileTracingIncludes`) -- without reaching for `any`. `unknown` plus this one guard is
 * the whole cast; callers construct genuinely-malformed fixtures, so the guard only rules out
 * non-objects, not the shape withCanopy itself is meant to reject at runtime.
 */
function asNextConfig(value: unknown): NextConfig {
  if (typeof value !== 'object' || value === null) {
    throw new Error('test fixture must be an object')
  }
  return value as NextConfig
}

describe('withCanopy', () => {
  beforeEach(() => {
    unresolvablePackages = []
    tracing.result = { includes: [], problem: undefined }
    tracing.nextMajor = 16
    tracing.hasConfig = true
    sharpTracingIncludesMock.mockClear()
    installedNextMajorMock.mockClear()
    hasNextConfigMock.mockClear()
  })

  describe('transpilePackages', () => {
    it('includes required canopy packages', () => {
      const result = withCanopy({})
      expect(result.transpilePackages).toContain('canopycms')
    })

    it('auto-detects installed optional packages', () => {
      // The mock resolves all packages successfully, so all optional packages are detected
      const result = withCanopy({})
      expect(result.transpilePackages).toContain('canopycms-next')
      expect(result.transpilePackages).toContain('canopycms-auth-clerk')
      expect(result.transpilePackages).toContain('canopycms-auth-dev')
      expect(result.transpilePackages).toContain('canopycms-cdk')
    })

    it('excludes optional packages that are not installed', () => {
      unresolvablePackages = ['canopycms-cdk', 'canopycms-auth-clerk']
      const result = withCanopy({})
      expect(result.transpilePackages).not.toContain('canopycms-cdk')
      expect(result.transpilePackages).not.toContain('canopycms-auth-clerk')
      expect(result.transpilePackages).toContain('canopycms-auth-dev')
      expect(result.transpilePackages).toContain('canopycms')
    })

    it('merges with existing transpilePackages', () => {
      const result = withCanopy({ transpilePackages: ['my-lib'] })
      expect(result.transpilePackages).toContain('my-lib')
      expect(result.transpilePackages).toContain('canopycms')
    })

    it('deduplicates packages', () => {
      const result = withCanopy({ transpilePackages: ['canopycms', 'my-lib'] })
      const count = result.transpilePackages!.filter((p) => p === 'canopycms').length
      expect(count).toBe(1)
    })

    it('includes additional packages from options', () => {
      const result = withCanopy({}, { packages: ['my-plugin'] })
      expect(result.transpilePackages).toContain('my-plugin')
      expect(result.transpilePackages).toContain('canopycms')
    })
  })

  describe('webpack config', () => {
    it('adds scoped React aliases via module.rules', () => {
      const result = withCanopy({})
      const webpackConfig = { module: { rules: [] } } as any
      const modified = invokeWebpack(result, webpackConfig)
      const reactRule = modified.module.rules.find((r: any) =>
        r.include?.toString().includes('canopycms'),
      )
      expect(reactRule).toBeDefined()
      expect(reactRule.resolve.alias).toHaveProperty('react')
      expect(reactRule.resolve.alias).toHaveProperty('react-dom')
      // Directory aliases — subpaths like react/jsx-runtime resolve naturally
      expect(reactRule.resolve.alias.react).toMatch(/node_modules[\\/]react$/)
      expect(reactRule.resolve.alias['react-dom']).toMatch(/node_modules[\\/]react-dom$/)
    })

    it('does not add global resolve.alias', () => {
      const result = withCanopy({})
      const webpackConfig = { resolve: {}, module: { rules: [] } } as any
      const modified = invokeWebpack(result, webpackConfig)
      expect(modified.resolve.alias).toBeUndefined()
    })

    it('chains existing webpack config function', () => {
      const existingWebpack = vi.fn((config: any) => ({ ...config, custom: true }))
      const result = withCanopy({ webpack: existingWebpack })
      const webpackConfig = { module: { rules: [] } } as any
      const modified = invokeWebpack(result, webpackConfig)
      expect(existingWebpack).toHaveBeenCalled()
      expect(modified.custom).toBe(true)
    })

    it('initializes module.rules when undefined', () => {
      const result = withCanopy({})
      const webpackConfig = {} as any
      const modified = invokeWebpack(result, webpackConfig)
      expect(modified.module.rules.length).toBeGreaterThan(0)
    })
  })

  describe('turbopack', () => {
    it('does not set turbopack aliases (absolute paths unsupported)', () => {
      const result = withCanopy({})
      expect(result.turbopack?.resolveAlias).toBeUndefined()
      expect(result.experimental?.turbo).toBeUndefined()
    })

    // Next 16 exits a `next build` or `next dev` that defaulted to Turbopack when the config has
    // a `webpack` key and no `turbopack` key -- and the alias function above is such a key.
    it.each([16, 17])(
      'sets an empty turbopack config on Next %i, answering for its own webpack function',
      (major) => {
        tracing.nextMajor = major
        const result = withCanopy({})
        expect(result.webpack).toBeTypeOf('function')
        expect(result.turbopack).toEqual({})
      },
    )

    it('does the same for a static export build', () => {
      expect(withCanopy({ output: 'export' }, { staticBuild: true }).turbopack).toEqual({})
    })

    // Next 15 only warns; Next 13 and 14 report an unknown top-level `turbopack` as invalid.
    it.each([13, 14, 15])('leaves turbopack unset on Next %i', (major) => {
      tracing.nextMajor = major
      expect(withCanopy({})).not.toHaveProperty('turbopack')
    })

    it('leaves turbopack unset when the Next version cannot be read', () => {
      tracing.nextMajor = null
      expect(withCanopy({})).not.toHaveProperty('turbopack')
    })

    // An adopter who already worked around the guard with `turbopack: {}` keeps their own value.
    it.each([{}, { resolveAlias: { foo: './bar' } }])(
      "keeps the adopter's own turbopack config (%o)",
      (turbopack) => {
        expect(withCanopy({ turbopack }).turbopack).toBe(turbopack)
      },
    )

    it("does not mutate the adopter's config object", () => {
      const nextConfig: NextConfig = { reactStrictMode: true }
      const result = withCanopy(nextConfig)
      expect(result.turbopack).toEqual({})
      expect(nextConfig).toEqual({ reactStrictMode: true })
    })

    it("treats turbopack: null as unset, as Next's guard does", () => {
      expect(withCanopy(asNextConfig({ turbopack: null })).turbopack).toEqual({})
    })

    it("leaves Next's guard in place for the adopter's own webpack config", () => {
      const result = withCanopy({ webpack: (config) => config })
      expect(result).not.toHaveProperty('turbopack')
    })

    it('adds nothing when there is no webpack function to answer for', () => {
      unresolvablePackages = ['react', 'react-dom']
      const result = withCanopy({})
      expect(result.webpack).toBeUndefined()
      expect(result).not.toHaveProperty('turbopack')
    })
  })

  describe('pageExtensions (dual-build)', () => {
    it('adds CMS page extensions by default', () => {
      const result = withCanopy({})
      expect(result.pageExtensions).toContain('server.ts')
      expect(result.pageExtensions).toContain('server.tsx')
      expect(result.pageExtensions).not.toContain('static.ts')
      expect(result.pageExtensions).not.toContain('static.tsx')
      // Also includes the default Next.js extensions
      expect(result.pageExtensions).toContain('tsx')
      expect(result.pageExtensions).toContain('ts')
    })

    it('adds CMS page extensions when staticBuild is explicitly false', () => {
      const result = withCanopy({}, { staticBuild: false })
      expect(result.pageExtensions).toContain('server.ts')
      expect(result.pageExtensions).toContain('server.tsx')
      expect(result.pageExtensions).not.toContain('static.ts')
      expect(result.pageExtensions).not.toContain('static.tsx')
    })

    it('merges with existing pageExtensions', () => {
      const result = withCanopy({ pageExtensions: ['tsx', 'ts', 'mdx'] })
      expect(result.pageExtensions).toContain('mdx')
      expect(result.pageExtensions).toContain('server.ts')
      expect(result.pageExtensions).toContain('server.tsx')
    })

    it('adds static page extensions instead of CMS extensions when staticBuild is true', () => {
      const result = withCanopy({}, { staticBuild: true })
      expect(result.pageExtensions).toContain('static.ts')
      expect(result.pageExtensions).toContain('static.tsx')
      expect(result.pageExtensions).not.toContain('server.ts')
      expect(result.pageExtensions).not.toContain('server.tsx')
      // Also includes the default Next.js extensions
      expect(result.pageExtensions).toContain('tsx')
      expect(result.pageExtensions).toContain('ts')
    })

    it('preserves and extends existing pageExtensions when staticBuild is true', () => {
      const result = withCanopy({ pageExtensions: ['tsx', 'ts', 'mdx'] }, { staticBuild: true })
      expect(result.pageExtensions).toContain('mdx')
      expect(result.pageExtensions).toContain('static.ts')
      expect(result.pageExtensions).toContain('static.tsx')
      expect(result.pageExtensions).not.toContain('server.ts')
    })
  })

  describe('generateBuildId (static-export reproducibility)', () => {
    const ORIGINAL_BUILD_ID = process.env.CANOPY_BUILD_ID

    afterEach(() => {
      if (ORIGINAL_BUILD_ID === undefined) delete process.env.CANOPY_BUILD_ID
      else process.env.CANOPY_BUILD_ID = ORIGINAL_BUILD_ID
      // This package has no vitest.config.ts, so `restoreMocks` is false. Without this, a spy
      // installed by a test that throws before its inline restore stays installed for the rest of
      // the file — which turns one real regression into a cascade of unrelated-looking failures.
      vi.restoreAllMocks()
    })

    /** Invoke the pinned resolver, asserting it was installed at all. */
    async function resolveBuildId(config: NextConfig): Promise<string | null> {
      expect(config.generateBuildId).toBeTypeOf('function')
      return await config.generateBuildId!()
    }

    it('is not installed at all on a non-static build', () => {
      process.env.CANOPY_BUILD_ID = 'deadbeef'
      // The CMS build keeps Next's random default on purpose: the two dual-build flavors have
      // different chunk sets, and one shared id would name both.
      expect(withCanopy({}, { staticBuild: false })).not.toHaveProperty('generateBuildId')
      expect(withCanopy({})).not.toHaveProperty('generateBuildId')
    })

    it('returns the env value on a static build', async () => {
      process.env.CANOPY_BUILD_ID = 'fd91b36c'
      expect(await resolveBuildId(withCanopy({}, { staticBuild: true }))).toBe('fd91b36c')
    })

    it('passes through an id containing "ad", which Next only re-rolls on the null path', async () => {
      // A hex tree hash routinely contains 'ad'. Next's re-roll loop runs only when the resolver
      // returns null, so returning the string directly is what makes a tree hash usable.
      process.env.CANOPY_BUILD_ID = 'ad0be123'
      expect(await resolveBuildId(withCanopy({}, { staticBuild: true }))).toBe('ad0be123')
    })

    it('falls back to null when unset', async () => {
      delete process.env.CANOPY_BUILD_ID
      expect(await resolveBuildId(withCanopy({}, { staticBuild: true }))).toBeNull()
    })

    it('falls back to null for an empty env var rather than producing an empty build id', async () => {
      // The `||` vs `??` case. An empty string survives `??`, then clears Next's
      // `typeof buildId !== 'string'` guard, and the build ships with an EMPTY build id.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      process.env.CANOPY_BUILD_ID = ''
      expect(await resolveBuildId(withCanopy({}, { staticBuild: true }))).toBeNull()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('NOT reproducible'))
    })

    it('falls back to null for a whitespace-only env var, and says so', async () => {
      // `||` alone is not enough: Next trims AFTER its `typeof buildId !== 'string'` guard, so a
      // whitespace-only value is truthy, clears the guard, and lands as an EMPTY build id.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      process.env.CANOPY_BUILD_ID = '   '
      expect(await resolveBuildId(withCanopy({}, { staticBuild: true }))).toBeNull()
      // Blank-but-set is a broken pipeline, not a choice: warn rather than silently shipping a
      // random id to someone who believes they pinned it.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('NOT reproducible'))
    })

    it('does not warn when the env var is simply unset', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      delete process.env.CANOPY_BUILD_ID
      await resolveBuildId(withCanopy({}, { staticBuild: true }))
      expect(warn).not.toHaveBeenCalled()
    })

    it('trims a padded env var, matching what Next itself would store', async () => {
      process.env.CANOPY_BUILD_ID = '  fd91b36c  '
      expect(await resolveBuildId(withCanopy({}, { staticBuild: true }))).toBe('fd91b36c')
    })

    it.each(['heads/main', '..', '.', 'has space', 'v1/2', 'a\\b', 'x'.repeat(256)])(
      'rejects %s, which Next would splice into _next/static/ unchanged',
      async (value) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        process.env.CANOPY_BUILD_ID = value
        expect(await resolveBuildId(withCanopy({}, { staticBuild: true }))).toBeNull()
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('[A-Za-z0-9._-]'))
      },
    )

    it.each(['fd91b36c', 'v1.2.3', 'build_id-42', 'ad0be123', 'a..b', 'x'.repeat(255)])(
      'accepts %s',
      async (value) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        process.env.CANOPY_BUILD_ID = value
        expect(await resolveBuildId(withCanopy({}, { staticBuild: true }))).toBe(value)
        expect(warn).not.toHaveBeenCalled()
      },
    )

    it('lets an explicit host config value win', async () => {
      process.env.CANOPY_BUILD_ID = 'from-env'
      const result = withCanopy({ generateBuildId: () => 'from-host' }, { staticBuild: true })
      expect(await resolveBuildId(result)).toBe('from-host')
    })
  })

  describe('published documentation', () => {
    it("keeps withCanopy's JSDoc attached to withCanopy", async () => {
      // This bug shipped once on this branch: a helper inserted between the JSDoc block and the
      // declaration orphans the block onto the helper, and `dist/config.d.ts` loses every line of
      // withCanopy's adopter-facing docs. Nothing in-repo notices, because workspace consumers
      // resolve `./config` to dist and never hover the type. Asserted on source order rather than
      // on emitted output so the check costs nothing and fails at the point of the mistake.
      const source = await readFile(new URL('./with-canopy.ts', import.meta.url), 'utf-8')
      const jsdocStart = source.indexOf('Wrap your Next.js config')
      expect(jsdocStart).toBeGreaterThan(-1)
      const afterBlock = source.slice(source.indexOf('*/', jsdocStart) + 2).trimStart()
      expect(afterBlock.startsWith('export function withCanopy(')).toBe(true)
    })
  })

  describe('config passthrough', () => {
    it('preserves other nextConfig properties', () => {
      const result = withCanopy({ reactStrictMode: true, distDir: 'build' })
      expect(result.reactStrictMode).toBe(true)
      expect(result.distDir).toBe('build')
    })

    it('preserves other experimental properties', () => {
      const result = withCanopy({
        experimental: { optimizeCss: true },
      })
      expect(result.experimental?.optimizeCss).toBe(true)
    })

    it('works with no arguments', () => {
      const result = withCanopy()
      expect(result.transpilePackages).toContain('canopycms')
    })
  })

  describe('assets rewrite', () => {
    const ASSETS_REWRITE = {
      source: '/assets/:path*',
      destination: '/api/canopycms/assets/raw/assets/:path*',
    }

    it('adds the assets rewrite when the user has no rewrites at all', async () => {
      const result = withCanopy({})
      const rewrites = await result.rewrites!()
      expect(rewrites).toEqual([ASSETS_REWRITE])
    })

    it('appends to a user rewrites array form (async function)', async () => {
      const result = withCanopy({
        rewrites: async () => [{ source: '/old', destination: '/new' }],
      })
      const rewrites = (await result.rewrites!()) as Array<{ source: string; destination: string }>
      expect(rewrites).toEqual([{ source: '/old', destination: '/new' }, ASSETS_REWRITE])
    })

    it('supports a non-async user rewrites function that returns a plain array', async () => {
      // Next's declared type requires a Promise-returning function, but real
      // next.config.js files are untyped JS - a sync function that just
      // returns the array is common in the wild. `await`ing a non-Promise
      // value resolves immediately, so this must not crash.
      const syncRewrites = (() => [
        { source: '/sync', destination: '/sync-dest' },
      ]) as unknown as NonNullable<NextConfig['rewrites']>
      const result = withCanopy({ rewrites: syncRewrites })
      const rewrites = (await result.rewrites!()) as Array<{ source: string; destination: string }>
      expect(rewrites).toEqual([{ source: '/sync', destination: '/sync-dest' }, ASSETS_REWRITE])
    })

    it('merges into afterFiles for the object rewrites form, leaving beforeFiles/fallback untouched', async () => {
      const result = withCanopy({
        rewrites: async () => ({
          beforeFiles: [{ source: '/before', destination: '/before-dest' }],
          afterFiles: [{ source: '/after', destination: '/after-dest' }],
          fallback: [{ source: '/fallback', destination: '/fallback-dest' }],
        }),
      })
      const rewrites = (await result.rewrites!()) as {
        beforeFiles: Array<{ source: string; destination: string }>
        afterFiles: Array<{ source: string; destination: string }>
        fallback: Array<{ source: string; destination: string }>
      }
      expect(rewrites.beforeFiles).toEqual([{ source: '/before', destination: '/before-dest' }])
      expect(rewrites.afterFiles).toEqual([
        { source: '/after', destination: '/after-dest' },
        ASSETS_REWRITE,
      ])
      expect(rewrites.fallback).toEqual([{ source: '/fallback', destination: '/fallback-dest' }])
    })

    it('handles the object form with buckets omitted entirely, defaulting them to empty arrays', async () => {
      const result = withCanopy({
        rewrites: async () => ({ afterFiles: [{ source: '/x', destination: '/y' }] }),
      })
      const rewrites = (await result.rewrites!()) as {
        beforeFiles: unknown[]
        afterFiles: Array<{ source: string; destination: string }>
        fallback: unknown[]
      }
      expect(rewrites.beforeFiles).toEqual([])
      expect(rewrites.fallback).toEqual([])
      expect(rewrites.afterFiles).toEqual([{ source: '/x', destination: '/y' }, ASSETS_REWRITE])
    })
  })

  describe('sharp libvips tracing (outputFileTracingIncludes)', () => {
    afterEach(() => {
      // Several tests below spy on or stub console.warn; restore between tests so a leaked spy
      // from one test cannot swallow or misattribute another test's warning.
      vi.restoreAllMocks()
    })

    it('adds the tracer include under "/**" for a server build and for output: standalone', () => {
      tracing.result = { includes: ['node_modules/@img/sharp-libvips-linux-arm64/lib/**/*'] }

      const server = withCanopy({})
      expect(server.outputFileTracingIncludes).toEqual({
        '/**': ['node_modules/@img/sharp-libvips-linux-arm64/lib/**/*'],
      })

      const standalone = withCanopy({ output: 'standalone' })
      expect(standalone.outputFileTracingIncludes).toEqual({
        '/**': ['node_modules/@img/sharp-libvips-linux-arm64/lib/**/*'],
      })
    })

    it('skips tracing entirely for a static export, without calling the tracer', () => {
      tracing.result = { includes: ['node_modules/@img/sharp-libvips-linux-arm64/lib/**/*'] }

      const exported = withCanopy({ output: 'export' })
      expect(exported).not.toHaveProperty('outputFileTracingIncludes')

      const staticBuild = withCanopy({}, { staticBuild: true })
      expect(staticBuild).not.toHaveProperty('outputFileTracingIncludes')

      expect(sharpTracingIncludesMock).not.toHaveBeenCalled()
    })

    it('merges into an existing "/**", dedupes, keeps other route keys, and does not mutate the input', () => {
      tracing.result = { includes: ['new/glob/**/*'] }

      const input = Object.freeze({
        outputFileTracingIncludes: Object.freeze({
          '/**': Object.freeze(['existing/glob/**/*', 'new/glob/**/*']),
          '/api/*': Object.freeze(['other/glob/**/*']),
        }),
      })
      const snapshot: unknown = JSON.parse(JSON.stringify(input))

      const result = withCanopy(input)

      expect(result.outputFileTracingIncludes?.['/**']).toHaveLength(2)
      expect(result.outputFileTracingIncludes?.['/**']).toEqual(
        expect.arrayContaining(['existing/glob/**/*', 'new/glob/**/*']),
      )
      expect(result.outputFileTracingIncludes?.['/api/*']).toEqual(['other/glob/**/*'])

      // Freezing above makes any real mutation throw; this is the belt-and-suspenders check that
      // the value withCanopy handed back is a genuinely separate object from the frozen input.
      expect(input).toEqual(snapshot)
    })

    it('adds no key when includes are empty and the adopter had none, and leaves an existing value untouched', () => {
      tracing.result = { includes: [] }

      const withoutExisting = withCanopy({})
      expect(withoutExisting).not.toHaveProperty('outputFileTracingIncludes')

      const existingValue = { '/**': ['keep/me/**/*'] }
      const withExisting = withCanopy({ outputFileTracingIncludes: existingValue })
      expect(withExisting.outputFileTracingIncludes).toEqual(existingValue)
    })

    it('passes projectDir, outputFileTracingRoot, and turbopack.root through to the tracer', () => {
      withCanopy({
        outputFileTracingRoot: '../shared-root',
        turbopack: { root: '../turbo-root' },
      })

      expect(sharpTracingIncludesMock).toHaveBeenCalledWith({
        projectDir: process.cwd(),
        outputFileTracingRoot: '../shared-root',
        turbopackRoot: '../turbo-root',
        lockfileRoot: 'outermost',
      })
    })

    it('writes under experimental for Next < 15, merging with an existing experimental value', () => {
      tracing.nextMajor = 14
      tracing.result = { includes: ['glob/**/*'] }

      const result = withCanopy({
        experimental: {
          outputFileTracingIncludes: { '/**': ['existing/**/*'] },
          outputFileTracingRoot: '../root-a',
          optimizeCss: true,
        },
      })

      expect(result).not.toHaveProperty('outputFileTracingIncludes')
      expect(result.experimental).toEqual({
        optimizeCss: true,
        outputFileTracingRoot: '../root-a',
        outputFileTracingIncludes: { '/**': ['existing/**/*', 'glob/**/*'] },
      })
      expect(sharpTracingIncludesMock).toHaveBeenCalledWith(
        expect.objectContaining({ outputFileTracingRoot: '../root-a' }),
      )
    })

    it('writes at the top level when the installed Next major is unreadable (null)', () => {
      tracing.nextMajor = null
      tracing.result = { includes: ['glob/**/*'] }

      const result = withCanopy({})
      expect(result.outputFileTracingIncludes).toEqual({ '/**': ['glob/**/*'] })
      expect(result).not.toHaveProperty('experimental')
    })

    it('merges under experimental on Next 15+ when the adopter still uses that spelling, since Next copies it over the top-level key', () => {
      tracing.nextMajor = 16
      tracing.result = { includes: ['glob/**/*'] }

      const result = withCanopy(
        asNextConfig({ experimental: { outputFileTracingIncludes: { '/**': ['legacy/**/*'] } } }),
      )

      expect(result).not.toHaveProperty('outputFileTracingIncludes')
      expect(result.experimental).toEqual({
        outputFileTracingIncludes: { '/**': ['legacy/**/*', 'glob/**/*'] },
      })
    })

    it('takes experimental.outputFileTracingRoot over the top-level value on Next 15+, as Next does', () => {
      tracing.nextMajor = 16

      withCanopy(
        asNextConfig({
          outputFileTracingRoot: '../top-level-root',
          experimental: { outputFileTracingRoot: '../legacy-root' },
        }),
      )

      expect(sharpTracingIncludesMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ outputFileTracingRoot: '../legacy-root' }),
      )
    })

    it('reads experimental.turbo.root on Next 15 only, with turbopack.root winning', () => {
      tracing.nextMajor = 15
      withCanopy(asNextConfig({ experimental: { turbo: { root: '../legacy-turbo' } } }))
      expect(sharpTracingIncludesMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ turbopackRoot: '../legacy-turbo' }),
      )

      withCanopy(
        asNextConfig({
          turbopack: { root: '../turbopack' },
          experimental: { turbo: { root: '../legacy-turbo' } },
        }),
      )
      expect(sharpTracingIncludesMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ turbopackRoot: '../turbopack' }),
      )

      // Next 16 dropped the `experimental.turbo` migration, so the legacy value no longer counts.
      tracing.nextMajor = 16
      withCanopy(asNextConfig({ experimental: { turbo: { root: '../legacy-turbo' } } }))
      expect(sharpTracingIncludesMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ turbopackRoot: undefined }),
      )
    })

    it.each([undefined, null])(
      'treats experimental.outputFileTracingIncludes: %s as unset on Next 15+, since Next drops it before migrating',
      (legacy) => {
        tracing.nextMajor = 16
        tracing.result = { includes: ['glob/**/*'] }

        const result = withCanopy(
          asNextConfig({
            outputFileTracingIncludes: { '/api/x': ['data/**/*'] },
            experimental: { outputFileTracingIncludes: legacy },
          }),
        )

        expect(result.outputFileTracingIncludes).toEqual({
          '/api/x': ['data/**/*'],
          '/**': ['glob/**/*'],
        })
      },
    )

    it.each([undefined, null])(
      'treats experimental.outputFileTracingRoot: %s as unset on Next 15+, keeping the top-level root',
      (legacy) => {
        tracing.nextMajor = 16

        withCanopy(
          asNextConfig({
            outputFileTracingRoot: '../top-level-root',
            experimental: { outputFileTracingRoot: legacy },
          }),
        )

        expect(sharpTracingIncludesMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ outputFileTracingRoot: '../top-level-root' }),
        )
      },
    )

    it('treats a null outputFileTracingIncludes as unset rather than malformed', () => {
      tracing.nextMajor = 16
      tracing.result = { includes: ['glob/**/*'] }

      const result = withCanopy(asNextConfig({ outputFileTracingIncludes: null }))

      expect(result.outputFileTracingIncludes).toEqual({ '/**': ['glob/**/*'] })
    })

    it('ignores an experimental value that is not an object, instead of throwing', () => {
      tracing.nextMajor = 16
      tracing.result = { includes: ['glob/**/*'] }

      const result = withCanopy(asNextConfig({ experimental: true }))

      expect(result.outputFileTracingIncludes).toEqual({ '/**': ['glob/**/*'] })
    })

    it('lets a root key on turbopack beat experimental.turbo.root on Next 15, even an empty one', () => {
      tracing.nextMajor = 15

      withCanopy(
        asNextConfig({
          turbopack: { root: undefined },
          experimental: { turbo: { root: '../legacy-turbo' } },
        }),
      )

      expect(sharpTracingIncludesMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ turbopackRoot: undefined }),
      )
    })

    it('asks for the closest-lockfile root on Next < 15 and the outermost on 15+, as each infers it', () => {
      tracing.nextMajor = 14
      withCanopy({})
      expect(sharpTracingIncludesMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ lockfileRoot: 'closest', outputFileTracingRoot: undefined }),
      )

      tracing.nextMajor = 16
      withCanopy({})
      expect(sharpTracingIncludesMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ lockfileRoot: 'outermost' }),
      )

      // An unreadable version is treated as Next 15 or later for the root, as it is for the key.
      tracing.nextMajor = null
      withCanopy({})
      expect(sharpTracingIncludesMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ lockfileRoot: 'outermost' }),
      )
    })

    it('leaves a malformed existing outputFileTracingIncludes value untouched', () => {
      tracing.result = { includes: ['glob/**/*'] }
      const malformed = asNextConfig({ outputFileTracingIncludes: { '/**': 'nope' } })

      const result = withCanopy(malformed)

      expect(result.outputFileTracingIncludes).toEqual({ '/**': 'nope' })
      // Detected and rejected before the tracer would even be asked to run.
      expect(sharpTracingIncludesMock).not.toHaveBeenCalled()
    })

    describe('warns once per module instance when standalone tracing fails', () => {
      // The warned-once flag is module-level state (see with-canopy.ts's `warnedAboutSharpTracing`),
      // so every test here gets its own fresh module instance via vi.resetModules() + a dynamic
      // import -- the vi.mock('./sharp-tracing', ...) factory above still applies to it -- rather
      // than sharing the top-level `withCanopy` import the rest of this file uses. Without that,
      // whichever of these tests runs first would "use up" the flag for the others.

      it('does not call the tracer when there is no next.config, and the warning says so', async () => {
        tracing.hasConfig = false
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        vi.resetModules()
        try {
          const fresh = await import('./with-canopy')
          fresh.withCanopy({ output: 'standalone' })

          expect(sharpTracingIncludesMock).not.toHaveBeenCalled()
          expect(warn).toHaveBeenCalledWith(expect.stringContaining('no next.config'))
        } finally {
          vi.resetModules()
        }
      })

      it('warns exactly once across two withCanopy calls in the same module instance', async () => {
        tracing.result = { includes: [], problem: 'boom' }
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        vi.resetModules()
        try {
          const fresh = await import('./with-canopy')
          fresh.withCanopy({ output: 'standalone' })
          fresh.withCanopy({ output: 'standalone' })

          expect(warn).toHaveBeenCalledTimes(1)
          const message = warn.mock.calls[0]?.[0]
          expect(message).toEqual(expect.stringContaining('boom'))
          expect(message).toEqual(
            expect.stringContaining(
              'node_modules/.pnpm/@img+sharp-libvips-*/node_modules/@img/*/lib/**/*',
            ),
          )
          expect(message).toEqual(
            expect.stringContaining('node_modules/@img/sharp-libvips-*/lib/**/*'),
          )
        } finally {
          vi.resetModules()
        }
      })

      it('does not warn for a non-standalone build even with empty includes', async () => {
        tracing.result = { includes: [], problem: 'boom' }
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        vi.resetModules()
        try {
          const fresh = await import('./with-canopy')
          fresh.withCanopy({})
          expect(warn).not.toHaveBeenCalled()
        } finally {
          vi.resetModules()
        }
      })

      it('warns on a standalone build when the Next version is unreadable and the include went top-level', async () => {
        tracing.nextMajor = null
        tracing.result = { includes: ['glob/**/*'] }
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        vi.resetModules()
        try {
          const fresh = await import('./with-canopy')
          const result = fresh.withCanopy({ output: 'standalone' })
          // A second evaluation in the same module instance must not warn again.
          fresh.withCanopy({ output: 'standalone' })

          expect(result.outputFileTracingIncludes).toEqual({ '/**': ['glob/**/*'] })
          expect(warn).toHaveBeenCalledTimes(1)
          expect(warn.mock.calls[0]?.[0]).toEqual(
            expect.stringContaining('experimental.outputFileTracingIncludes'),
          )
        } finally {
          vi.resetModules()
        }
      })

      it('does not warn about the version when it is readable, or when a legacy experimental include decides the key', async () => {
        tracing.result = { includes: ['glob/**/*'] }
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        vi.resetModules()
        try {
          const fresh = await import('./with-canopy')
          tracing.nextMajor = 16
          fresh.withCanopy({ output: 'standalone' })
          // Written under `experimental`, which every Next version reads, so the version is moot.
          tracing.nextMajor = null
          fresh.withCanopy(
            asNextConfig({ output: 'standalone', experimental: { outputFileTracingIncludes: {} } }),
          )

          expect(warn).not.toHaveBeenCalled()
        } finally {
          vi.resetModules()
        }
      })

      it('adds the version note to the nothing-found warning when the version is unreadable too', async () => {
        tracing.nextMajor = null
        tracing.result = { includes: [], problem: 'boom' }
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        vi.resetModules()
        try {
          const fresh = await import('./with-canopy')
          fresh.withCanopy({ output: 'standalone' })

          expect(warn).toHaveBeenCalledTimes(1)
          expect(warn.mock.calls[0]?.[0]).toEqual(
            expect.stringContaining('version could not be read'),
          )
        } finally {
          vi.resetModules()
        }
      })
    })
  })
})
