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

/** Same shape as DevAuthPlugin: verifyTokenOnly implemented, no verifiesCredentials marker. */
const unmarkedDevPlugin: AuthPlugin = {
  ...basePlugin,
  verifyTokenOnly: async () => ({ userId: 'dev_user' }),
}

/** A verifying plugin (e.g. Clerk): verifyTokenOnly AND verifiesCredentials: true. */
const verifyingPlugin: AuthPlugin = {
  ...basePlugin,
  verifiesCredentials: true,
  verifyTokenOnly: async () => ({ userId: 'real_user' }),
}

describe('createNextCanopyContext auth plugin guard (SEC-C1)', () => {
  it('rejects an unmarked auth plugin when mode is prod', async () => {
    await expect(
      createNextCanopyContext({
        config: config({ mode: 'prod' }),
        authPlugin: unmarkedDevPlugin,
        entrySchemaRegistry: {},
      }),
    ).rejects.toThrow(/mode: 'prod'.*does not affirm.*verifiesCredentials/)
  })

  it('accepts the same unmarked plugin when mode is dev', async () => {
    const result = await createNextCanopyContext({
      config: config({ mode: 'dev' }),
      authPlugin: unmarkedDevPlugin,
      entrySchemaRegistry: {},
    })
    expect(result.handler).toBeTypeOf('function')
  })

  it('accepts a verifying plugin (verifiesCredentials: true) in prod', async () => {
    const result = await createNextCanopyContext({
      config: config({ mode: 'prod' }),
      authPlugin: verifyingPlugin,
      entrySchemaRegistry: {},
    })
    expect(result.handler).toBeTypeOf('function')
  })

  it('resolves for prod + deployedAs: static + no authPlugin (static stub passes the allowlist)', async () => {
    const result = await createNextCanopyContext({
      config: config({ mode: 'prod', deployedAs: 'static' }),
      entrySchemaRegistry: {},
    })
    expect(result.handler).toBeTypeOf('function')
  })
})
