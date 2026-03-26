import { describe, expect, it, vi } from 'vitest'
import type { NextConfig } from 'next'

// Mock node:module so we can control what require.resolve returns
vi.mock('node:module', () => ({
  createRequire: () => ({
    resolve: (id: string) => `/mock/node_modules/${id.replace(/\//g, '_')}/index.js`,
  }),
}))

import { withCanopy } from './with-canopy'

/** Helper to invoke the webpack function from a withCanopy result */
function invokeWebpack(config: NextConfig, webpackConfig: unknown) {
  const webpackFn = config.webpack as NonNullable<NextConfig['webpack']>
  return webpackFn(webpackConfig as any, {} as any)
}

describe('withCanopy', () => {
  describe('transpilePackages', () => {
    it('includes all canopy packages', () => {
      const result = withCanopy({})
      expect(result.transpilePackages).toContain('canopycms')
      expect(result.transpilePackages).toContain('canopycms-next')
      expect(result.transpilePackages).toContain('canopycms-auth-clerk')
      expect(result.transpilePackages).toContain('canopycms-auth-dev')
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
    it('adds React aliases', () => {
      const result = withCanopy({})
      const webpackConfig = { resolve: {} } as any
      const modified = invokeWebpack(result, webpackConfig)
      expect(modified.resolve.alias).toHaveProperty('react')
      expect(modified.resolve.alias).toHaveProperty('react-dom')
      expect(modified.resolve.alias).toHaveProperty('react/jsx-runtime')
      expect(modified.resolve.alias).toHaveProperty('react/jsx-dev-runtime')
      expect(modified.resolve.alias).toHaveProperty('react-dom/client')
    })

    it('sets resolve.symlinks to false', () => {
      const result = withCanopy({})
      const webpackConfig = { resolve: {} } as any
      const modified = invokeWebpack(result, webpackConfig)
      expect(modified.resolve.symlinks).toBe(false)
    })

    it('preserves existing webpack aliases', () => {
      const result = withCanopy({})
      const webpackConfig = {
        resolve: { alias: { 'my-lib': '/path/to/my-lib' } },
      } as any
      const modified = invokeWebpack(result, webpackConfig)
      expect(modified.resolve.alias['my-lib']).toBe('/path/to/my-lib')
      expect(modified.resolve.alias).toHaveProperty('react')
    })

    it('chains existing webpack config function', () => {
      const existingWebpack = vi.fn((config: any) => ({ ...config, custom: true }))
      const result = withCanopy({ webpack: existingWebpack })
      const webpackConfig = { resolve: {} } as any
      const modified = invokeWebpack(result, webpackConfig)
      expect(existingWebpack).toHaveBeenCalled()
      expect(modified.custom).toBe(true)
    })

    it('initializes resolve when undefined', () => {
      const result = withCanopy({})
      const webpackConfig = {} as any
      const modified = invokeWebpack(result, webpackConfig)
      expect(modified.resolve.alias).toHaveProperty('react')
    })
  })

  describe('turbopack config', () => {
    it('adds resolveAlias for React', () => {
      const result = withCanopy({})
      expect(result.experimental?.turbo?.resolveAlias).toHaveProperty('react')
      expect(result.experimental?.turbo?.resolveAlias).toHaveProperty('react-dom')
    })

    it('preserves existing turbo config', () => {
      const result = withCanopy({
        experimental: {
          turbo: {
            resolveExtensions: ['.ts'],
          },
        },
      })
      expect(result.experimental?.turbo?.resolveExtensions).toEqual(['.ts'])
      expect(result.experimental?.turbo?.resolveAlias).toHaveProperty('react')
    })

    it('merges with existing turbo resolveAlias', () => {
      const result = withCanopy({
        experimental: {
          turbo: {
            resolveAlias: { 'my-lib': '/path/to/my-lib' },
          },
        },
      })
      const aliases = result.experimental?.turbo?.resolveAlias as Record<string, string>
      expect(aliases['my-lib']).toBe('/path/to/my-lib')
      expect(aliases).toHaveProperty('react')
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
})
