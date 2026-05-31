import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanopyBuildContext } from 'canopycms/server'
import type { CanopyConfig } from 'canopycms'
import { guardBuildContext } from './context-wrapper'

/** Minimal build context whose methods resolve so we can tell "threw" from "passed". */
function fakeBuildCtx(): CanopyBuildContext {
  return {
    services: {} as CanopyBuildContext['services'],
    buildContentTree: async () => [],
    listEntries: async () => [],
    read: async () => ({ data: undefined, path: '' }),
    readByUrlPath: async () => null,
  }
}

function config(partial: Partial<CanopyConfig>): CanopyConfig {
  return { mode: 'dev', deployedAs: 'server', ...partial } as CanopyConfig
}

const ALL_METHODS = ['buildContentTree', 'listEntries', 'read', 'readByUrlPath'] as const

async function callAll(ctx: CanopyBuildContext) {
  await ctx.buildContentTree()
  await ctx.listEntries()
  await ctx.read({ entryPath: 'content/x' })
  await ctx.readByUrlPath('/x')
}

describe('guardBuildContext', () => {
  afterEach(() => {
    delete process.env.CANOPY_BUILD_MODE
    delete process.env.NEXT_PHASE
    vi.restoreAllMocks()
  })

  it('throws on every method for a production server deployment at request time', async () => {
    const guarded = guardBuildContext(
      fakeBuildCtx(),
      config({ mode: 'prod', deployedAs: 'server' }),
    )
    for (const method of ALL_METHODS) {
      await expect(async () => {
        // @ts-expect-error dynamic method access for the test matrix
        await guarded[method]('/x')
      }).rejects.toThrow(/build context bypasses all branch and path ACLs/)
    }
  })

  it('does NOT throw in build mode, even on a production server deployment', async () => {
    process.env.CANOPY_BUILD_MODE = 'true'
    const guarded = guardBuildContext(
      fakeBuildCtx(),
      config({ mode: 'prod', deployedAs: 'server' }),
    )
    await expect(callAll(guarded)).resolves.not.toThrow()
  })

  it('does NOT throw in dev mode (Next runs generateStaticParams/Metadata there with the build context)', async () => {
    const guarded = guardBuildContext(fakeBuildCtx(), config({ mode: 'dev', deployedAs: 'server' }))
    await expect(callAll(guarded)).resolves.not.toThrow()
  })

  it('does NOT throw on a static deployment (no runtime ACLs to bypass)', async () => {
    const guarded = guardBuildContext(
      fakeBuildCtx(),
      config({ mode: 'prod', deployedAs: 'static' }),
    )
    await expect(callAll(guarded)).resolves.not.toThrow()
  })
})
