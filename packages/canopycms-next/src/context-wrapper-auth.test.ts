import { describe, expect, it, vi } from 'vitest'
import type { CanopyConfig } from 'canopycms'
import type { AuthPlugin } from 'canopycms/auth'

// React's cache() is a server-components API not available in the node test
// environment; identity is equivalent for these tests (no per-request scoping).
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, cache: <T>(fn: T): T => fn }
})

// Mock service creation and the dev watcher so createNextCanopyContext can run
// without a real workspace/filesystem. Everything else stays real — in particular
// assertAuthPluginAllowedForMode, which is what these tests exercise.
vi.mock('canopycms/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('canopycms/server')>()
  return {
    ...actual,
    createCanopyServices: vi.fn(async (config: CanopyConfig) => ({
      config,
      bootstrapAdminIds: new Set<string>(),
      refreshActiveBranch: vi.fn(),
    })),
    startDevContentWatcher: vi.fn(),
  }
})

import { createNextCanopyContext } from './context-wrapper'

function config(partial: Partial<CanopyConfig>): CanopyConfig {
  return { mode: 'dev', deployedAs: 'server', ...partial } as CanopyConfig
}

const basePlugin: AuthPlugin = {
  authenticate: async () => ({ success: false, error: 'not used' }),
  searchUsers: async () => [],
  getUserMetadata: async () => null,
  getGroupMetadata: async () => null,
  listGroups: async () => [],
}

/** Same shape as DevAuthPlugin: insecure marker AND verifyTokenOnly implemented. */
const insecureDevPlugin: AuthPlugin = {
  ...basePlugin,
  insecureDevOnly: true,
  verifyTokenOnly: async () => ({ userId: 'dev_user' }),
}

/** A verifying plugin (e.g. Clerk): verifyTokenOnly without the insecure marker. */
const verifyingPlugin: AuthPlugin = {
  ...basePlugin,
  verifyTokenOnly: async () => ({ userId: 'real_user' }),
}

describe('createNextCanopyContext auth plugin guard (SEC-C1)', () => {
  it('rejects an insecure dev-only auth plugin when mode is prod', async () => {
    await expect(
      createNextCanopyContext({
        config: config({ mode: 'prod' }),
        authPlugin: insecureDevPlugin,
        entrySchemaRegistry: {},
      }),
    ).rejects.toThrow(/dev\/insecure auth plugin.*mode: 'prod'/)
  })

  it('accepts the same insecure plugin when mode is dev', async () => {
    const result = await createNextCanopyContext({
      config: config({ mode: 'dev' }),
      authPlugin: insecureDevPlugin,
      entrySchemaRegistry: {},
    })
    expect(result.handler).toBeTypeOf('function')
  })

  it('accepts a verifying plugin (verifyTokenOnly, no marker) in prod', async () => {
    const result = await createNextCanopyContext({
      config: config({ mode: 'prod' }),
      authPlugin: verifyingPlugin,
      entrySchemaRegistry: {},
    })
    expect(result.handler).toBeTypeOf('function')
  })
})
