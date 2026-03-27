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
