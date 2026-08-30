import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
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

import { withCanopy } from './with-canopy'

/** Helper to invoke the webpack function from a withCanopy result */
function invokeWebpack(config: NextConfig, webpackConfig: unknown) {
  const webpackFn = config.webpack as NonNullable<NextConfig['webpack']>
  return webpackFn(webpackConfig as any, {} as any)
}

describe('withCanopy', () => {
  beforeEach(() => {
    unresolvablePackages = []
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

  describe('turbopack limitation', () => {
    it('does not set turbopack aliases (absolute paths unsupported)', () => {
      const result = withCanopy({}) as any
      expect(result.turbopack).toBeUndefined()
      expect(result.experimental?.turbo).toBeUndefined()
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

    it('returns the env value verbatim on a static build', async () => {
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
      process.env.CANOPY_BUILD_ID = ''
      expect(await resolveBuildId(withCanopy({}, { staticBuild: true }))).toBeNull()
    })

    it('lets an explicit host config value win', async () => {
      process.env.CANOPY_BUILD_ID = 'from-env'
      const result = withCanopy({ generateBuildId: () => 'from-host' }, { staticBuild: true })
      expect(await resolveBuildId(result)).toBe('from-host')
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
})
