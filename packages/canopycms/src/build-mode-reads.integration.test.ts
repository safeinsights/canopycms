/**
 * End-to-end proof that at build time every public read comes from the working
 * tree (process.cwd()) with ZERO git invocations — for a server deployment, in
 * dev and prod mode, under either build-mode switch (`NEXT_PHASE` or
 * `CANOPY_BUILD_MODE`) — the behavior `readsFromCheckout` (build-mode.ts) is
 * meant to guarantee. Static deployments already took this path; their test
 * sits beside the build-mode twins in branch-workspace.test.ts.
 *
 * Unlike branch-workspace.test.ts / services.test.ts / ai/resolve-branch.test.ts,
 * which each pin one module's use of the predicate, this test drives the REAL
 * `createCanopyServices` + `createCanopyContext` stack end to end against a temp
 * project directory that is deliberately NOT a git repository — proving the whole
 * read surface (`read`, `readByUrlPath`, `listEntries`, `buildContentTree`) works
 * without git even existing, not merely that it skips git when git IS available.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let simpleGitFactoryCalls = 0
vi.mock('simple-git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('simple-git')>()
  const counting = ((...args: Parameters<typeof actual.simpleGit>) => {
    simpleGitFactoryCalls++
    return actual.simpleGit(...args)
  }) as typeof actual.simpleGit
  // `default` is the same function object as the named export on the real module
  // (simple-git's module.exports IS the factory, with named properties attached
  // to it) — nothing in this codebase imports it that way, but wrap it too so the
  // mock does not silently leave an uncounted door open.
  return { ...actual, simpleGit: counting, default: counting }
})

import { flattenSchema, type RootCollectionConfig } from './config'
import { defineCanopyTestConfig } from './config-test'
import { createCanopyServices, type CreateCanopyServicesOptions } from './services'
import { createCanopyContext } from './context'
import { ContentStore } from './content-store'
import { unsafeAsLogicalPath, unsafeAsSlug } from './paths/test-utils'
import type { OperatingMode } from './operating-mode'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-build-reads-'))

const testSchema: RootCollectionConfig = {
  entries: [
    {
      name: 'home',
      format: 'md',
      default: true,
      schema: [{ name: 'title', type: 'string' }],
    },
  ],
  collections: [
    {
      name: 'posts',
      path: 'posts',
      entries: [
        {
          name: 'post',
          format: 'md',
          default: true,
          schema: [{ name: 'title', type: 'string' }],
        },
      ],
    },
  ],
}

/** Seed the working-tree content this whole file reads. Not a git repo. */
async function seedWorkingTreeContent(
  root: string,
  config: ReturnType<typeof defineCanopyTestConfig>,
) {
  const flat = flattenSchema(testSchema, config.contentRoot)
  const store = new ContentStore(root, flat)

  // Root-level index/home entry — readable via URL path '/'.
  await store.write(unsafeAsLogicalPath('content'), unsafeAsSlug('index'), {
    format: 'md',
    data: { title: 'Working Tree Home' },
    body: '# Home\n',
  })

  // Two entries in a real collection, one readable via a URL path.
  await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('hello-world'), {
    format: 'md',
    data: { title: 'Working Tree Hello' },
    body: '# Hello\n',
  })
  await store.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('second-post'), {
    format: 'md',
    data: { title: 'Working Tree Second' },
    body: '# Second\n',
  })

  return flat
}

/**
 * Branch-schema cache stand-in that always returns the fixed test schema,
 * regardless of which branchRoot it's asked about. This test's subject is
 * WHERE content is read from (branchRoot), not schema resolution — using the
 * real disk-based BranchSchemaCache would require a full .collection.json
 * fixture tree for no added coverage of the code path under test. Mirrors the
 * mockBranchSchemaCache pattern in services.test.ts / config-test.ts.
 */
function makeBranchSchemaCache(
  flat: ReturnType<typeof flattenSchema>,
): NonNullable<CreateCanopyServicesOptions['branchSchemaCache']> {
  return {
    getSchema: async () => ({ schema: testSchema, flatSchema: flat }),
    invalidate: async () => {},
  } as unknown as NonNullable<CreateCanopyServicesOptions['branchSchemaCache']>
}

/** extractUser that throws — proves the build WHO bypass (STATIC_DEPLOY_USER) is in effect too. */
const extractUserMustNotBeCalled = async (): Promise<never> => {
  throw new Error('extractUser must not be called at build — STATIC_DEPLOY_USER bypasses it')
}

describe('at build, every public read comes from the working tree with zero git', () => {
  beforeEach(() => {
    simpleGitFactoryCalls = 0
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each([
    ['dev' as OperatingMode, 'NEXT_PHASE', 'phase-production-build'] as const,
    ['prod' as OperatingMode, 'NEXT_PHASE', 'phase-production-build'] as const,
    ['dev' as OperatingMode, 'CANOPY_BUILD_MODE', 'true'] as const,
  ])('%s mode, deployedAs=server, build via %s=%s', async (mode, envVar, envValue) => {
    const root = await tmpDir()
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
    try {
      const config = defineCanopyTestConfig({ schema: testSchema }, { mode, deployedAs: 'server' })
      const flat = await seedWorkingTreeContent(root, config)

      vi.stubEnv(envVar, envValue)

      const services = await createCanopyServices(config, {
        branchSchemaCache: makeBranchSchemaCache(flat),
      })
      const { getContext } = createCanopyContext({
        services,
        extractUser: extractUserMustNotBeCalled,
      })
      const context = await getContext()

      // WHO: the synthetic build user, never the adapter's extractUser (which throws).
      expect(context.user.userId).toBe('__static_deploy__')

      // WHERE: listEntries / buildContentTree
      const entries = await context.listEntries()
      expect(entries.length).toBeGreaterThan(0)
      const hello = entries.find((e) => e.urlPath === '/posts/hello-world')
      expect(hello?.data.title).toBe('Working Tree Hello')

      const tree = await context.buildContentTree()
      expect(tree.length).toBeGreaterThan(0)

      // WHERE: read() by logical path
      const read = await context.read<{ title: string }>({
        entryPath: 'content/posts',
        slug: 'hello-world',
      })
      expect(read.data.title).toBe('Working Tree Hello')

      // WHERE: readByUrlPath(), plain
      const byUrl = await context.readByUrlPath<{ title: string }>('/posts/hello-world')
      expect(byUrl?.data.title).toBe('Working Tree Hello')

      // WHERE: readByUrlPath() with an explicit branch option — readsFromCheckout
      // ignores the branch name entirely for WHERE content comes from (still cwd),
      // but the returned `path` still carries the branch as a query suffix.
      const byUrlWithBranch = await context.readByUrlPath<{ title: string }>('/posts/hello-world', {
        branch: 'feature-x',
      })
      expect(byUrlWithBranch?.data.title).toBe('Working Tree Hello')
      expect(byUrlWithBranch?.path).toBe('/posts/hello-world?branch=feature-x')

      // Root index entry, readable via '/'.
      const home = await context.readByUrlPath<{ title: string }>('/')
      expect(home?.data.title).toBe('Working Tree Home')

      // GIT: never invoked.
      expect(simpleGitFactoryCalls).toBe(0)
      // No workspace directory materializes at the project root.
      await expect(fs.access(path.join(root, '.canopy-dev'))).rejects.toThrow()
    } finally {
      cwdSpy.mockRestore()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('ignores an existing stale .canopy-dev branch clone entirely', async () => {
    const root = await tmpDir()
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
    try {
      const config = defineCanopyTestConfig(
        { schema: testSchema },
        { mode: 'dev', deployedAs: 'server' },
      )
      const flat = await seedWorkingTreeContent(root, config)

      // Pre-seed a stale branch clone at the exact path loadBranchContext would
      // resolve for branchName 'main' in dev mode with no basePathOverride
      // (<cwd>/.canopy-dev/content-branches/main) — with DIFFERENT content and
      // valid metadata, so that without the readsFromCheckout fix,
      // loadOrCreateBranchContext would happily find and serve it instead of
      // reading the working tree.
      const staleBranchRoot = path.join(root, '.canopy-dev', 'content-branches', 'main')
      const staleStore = new ContentStore(staleBranchRoot, flat)
      await staleStore.write(unsafeAsLogicalPath('content/posts'), unsafeAsSlug('hello-world'), {
        format: 'md',
        data: { title: 'STALE — should never be served at build' },
        body: '# Stale\n',
      })

      const now = new Date().toISOString()
      await fs.mkdir(path.join(staleBranchRoot, '.canopy-meta'), { recursive: true })
      await fs.writeFile(
        path.join(staleBranchRoot, '.canopy-meta', 'branch.json'),
        JSON.stringify({
          schemaVersion: 1,
          version: 1,
          branch: {
            name: 'main',
            status: 'editing',
            access: {},
            createdBy: 'stale-clone-seed',
            createdAt: now,
            updatedAt: now,
          },
        }),
        'utf8',
      )

      vi.stubEnv('NEXT_PHASE', 'phase-production-build')

      const services = await createCanopyServices(config, {
        branchSchemaCache: makeBranchSchemaCache(flat),
      })
      const { getContext } = createCanopyContext({
        services,
        extractUser: extractUserMustNotBeCalled,
      })
      const context = await getContext()

      const byUrl = await context.readByUrlPath<{ title: string }>('/posts/hello-world')
      expect(byUrl?.data.title).toBe('Working Tree Hello')

      expect(simpleGitFactoryCalls).toBe(0)
    } finally {
      cwdSpy.mockRestore()
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
