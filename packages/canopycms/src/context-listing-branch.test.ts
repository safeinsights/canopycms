import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTestServices } from './config-test'
import { createCanopyContext } from './context'
import type { OperatingMode } from './operating-mode'
import type { BranchAccessControl, BranchContext } from './types'

/**
 * Branch workspaces keyed by name. `loadOrCreateBranchContext` stands in for provisioning and is
 * spied on, so a test can assert a requested branch never reaches it; `loadBranchContext` answers
 * only for a branch that already exists.
 */
const branches = new Map<string, BranchContext>()
const provisioned: string[] = []
vi.mock('./branch-workspace', async () => {
  const { BranchPathError } = await import('./paths')
  const { sanitizeBranchName } = await import('./paths/branch-name')
  return {
    loadOrCreateBranchContext: async ({ branchName }: { branchName: string }) => {
      provisioned.push(branchName)
      const existing = branches.get(branchName)
      if (!existing) throw new Error(`test fixture has no branch ${branchName}`)
      return existing
    },
    loadBranchContext: async ({ branchName }: { branchName: string }) => {
      if (branchName.includes('..')) {
        throw new BranchPathError('Branch name cannot contain traversal segments')
      }
      // The real loader sanitizes next, which throws on anything but a string.
      sanitizeBranchName(branchName)
      return branches.get(branchName) ?? null
    },
  }
})

const schema = {
  collections: [
    {
      name: 'posts',
      path: 'posts',
      entries: [
        {
          name: 'post',
          format: 'json' as const,
          default: true,
          schema: [{ name: 'title', type: 'string' as const }],
        },
      ],
    },
  ],
}

const ENTRY_IDS = ['RRMDbToFJNTf', 'aB3cD4eF5gH6', 'cD5eF6gH7jK8']

const USER = {
  type: 'authenticated' as const,
  userId: 'editor-1',
  name: 'Editor',
  email: 'editor@example.com',
  groups: [],
}

describe('listEntries / buildContentTree with a branch option', () => {
  let root: string

  const addBranch = async (
    name: string,
    slugs: string[],
    access: BranchAccessControl = {},
  ): Promise<string> => {
    const branchRoot = path.join(root, name)
    const postsDir = path.join(branchRoot, 'content/posts')
    await fs.mkdir(postsDir, { recursive: true })
    for (const [i, slug] of slugs.entries()) {
      await fs.writeFile(
        path.join(postsDir, `post.${slug}.${ENTRY_IDS[i]}.json`),
        JSON.stringify({ title: slug }),
      )
    }
    const now = new Date().toISOString()
    branches.set(name, {
      baseRoot: root,
      branchRoot,
      branch: {
        name,
        status: 'editing',
        access,
        createdBy: 'someone-else',
        createdAt: now,
        updatedAt: now,
      },
    })
    return branchRoot
  }

  const contextFor = async (mode: OperatingMode, defaultBranchAccess: 'allow' | 'deny') => {
    const services = await createTestServices(
      {
        mode,
        defaultBaseBranch: 'main',
        defaultActiveBranch: 'main',
        defaultBranchAccess,
        defaultPathAccess: 'allow',
        schema,
      },
      { getSettingsBranchRoot: () => Promise.resolve(root) },
    )
    const ctx = await createCanopyContext({ services, extractUser: async () => USER }).getContext()
    return { ctx, services }
  }

  const treeSlugs = (nodes: Awaited<ReturnType<typeof treeOf>>): (string | undefined)[] =>
    nodes.flatMap((n) => [n.entry?.slug, ...treeSlugs(n.children ?? [])]).filter(Boolean)
  const treeOf = (ctx: Awaited<ReturnType<typeof contextFor>>['ctx'], branch?: string) =>
    ctx.buildContentTree({ branch })

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-listing-branch-'))
    branches.clear()
    provisioned.length = 0
    vi.unstubAllEnvs()
    // Base has `kept` and `removed`; the content branch deleted `removed` and added `added`.
    await addBranch('main', ['kept', 'removed'])
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('lists the requested content branch in prod, not the base branch', async () => {
    await addBranch('feature', ['kept', 'added'])
    const { ctx } = await contextFor('prod', 'allow')

    const slugs = (await ctx.listEntries({ branch: 'feature' })).map((e) => e.slug).sort()
    expect(slugs).toEqual(['added', 'kept'])

    expect(treeSlugs(await treeOf(ctx, 'feature')).sort()).toEqual(['added', 'kept'])
  })

  it('still lists the active branch when no branch is passed', async () => {
    await addBranch('feature', ['kept', 'added'])
    for (const mode of ['prod', 'dev'] as const) {
      const { ctx } = await contextFor(mode, 'allow')
      expect((await ctx.listEntries()).map((e) => e.slug).sort()).toEqual(['kept', 'removed'])
      expect(treeSlugs(await treeOf(ctx)).sort()).toEqual(['kept', 'removed'])
    }
  })

  it('lists the requested branch in dev too', async () => {
    await addBranch('feature', ['kept', 'added'])
    const { ctx } = await contextFor('dev', 'allow')
    expect((await ctx.listEntries({ branch: 'feature' })).map((e) => e.slug).sort()).toEqual([
      'added',
      'kept',
    ])
  })

  it('lists nothing from a branch the user cannot access, without reading it', async () => {
    await addBranch('feature', ['kept', 'added'], { allowedUsers: ['someone-else'] })
    const { ctx, services } = await contextFor('prod', 'allow')
    const schemaSpy = vi.spyOn(services.branchSchemaCache, 'getSchema')

    expect(await ctx.listEntries({ branch: 'feature' })).toEqual([])
    expect(await treeOf(ctx, 'feature')).toEqual([])
    expect(schemaSpy).not.toHaveBeenCalledWith(
      path.join(root, 'feature'),
      expect.anything(),
      expect.anything(),
    )
  })

  it('lists nothing from an un-ACL’d branch under defaultBranchAccess "deny"', async () => {
    await addBranch('feature', ['kept', 'added'])
    const { ctx } = await contextFor('prod', 'deny')

    expect(await ctx.listEntries({ branch: 'feature' })).toEqual([])
    // The base branch stays readable through the protected-base-branch grant.
    expect((await ctx.listEntries()).map((e) => e.slug).sort()).toEqual(['kept', 'removed'])
  })

  it('never provisions a requested branch that does not exist', async () => {
    const { ctx } = await contextFor('prod', 'allow')

    expect(await ctx.listEntries({ branch: 'no-such-branch' })).toEqual([])
    expect(await treeOf(ctx, 'no-such-branch')).toEqual([])
    expect(provisioned).not.toContain('no-such-branch')
  })

  it('lists nothing for a traversal branch name rather than throwing', async () => {
    const { ctx } = await contextFor('prod', 'allow')
    expect(await ctx.listEntries({ branch: '../main' })).toEqual([])
  })

  it('lists nothing for a repeated ?branch= that arrives as an array', async () => {
    await addBranch('feature', ['kept', 'added'])
    const { ctx } = await contextFor('prod', 'allow')
    // Untyped page props hand this through as-is.
    const branch = ['feature', 'main'] as unknown as string
    expect(await ctx.listEntries({ branch })).toEqual([])
    expect(await treeOf(ctx, branch)).toEqual([])
  })

  it('resolves each branch once per request, and the active branch named explicitly shares the default', async () => {
    const featureRoot = await addBranch('feature', ['kept', 'added'])
    const { ctx, services } = await contextFor('prod', 'allow')
    const schemaSpy = vi.spyOn(services.branchSchemaCache, 'getSchema')

    await ctx.listEntries({ branch: 'feature' })
    await treeOf(ctx, 'feature')
    expect((await ctx.listEntries({ branch: 'main' })).map((e) => e.slug).sort()).toEqual([
      'kept',
      'removed',
    ])
    await ctx.listEntries()

    const roots = schemaSpy.mock.calls.map(([branchRoot]) => branchRoot)
    expect(roots).toEqual([featureRoot, path.join(root, 'main')])
    expect(provisioned).toEqual(['main'])
  })

  it('ignores the branch option at build time, listing the checkout', async () => {
    await addBranch('feature', ['kept', 'added'])
    vi.stubEnv('CANOPY_BUILD_MODE', 'true')
    const { ctx } = await contextFor('prod', 'allow')

    expect((await ctx.listEntries({ branch: 'feature' })).map((e) => e.slug).sort()).toEqual([
      'kept',
      'removed',
    ])
  })
})
