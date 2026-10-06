import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BranchWorkspaceManager } from './branch-workspace'
import { createTestServices } from './config-test'
import { ContentStoreError } from './content-store'
import { createCanopyContext } from './context'
import { GitManager } from './git-manager'
import type { BranchAccessControl } from './types'

/**
 * Real branch workspaces under a temporary prod workspace root. Only git is stubbed (the clone is
 * a bare mkdir, the checkout a no-op), so `provisioned` records every workspace the code under
 * test sets up and a provisioned branch leaves a real directory and `branch.json` behind.
 */
const provisioned: string[] = []

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

const USER = {
  type: 'authenticated' as const,
  userId: 'editor-1',
  name: 'Editor',
  email: 'editor@example.com',
  groups: [],
}

describe('read / readByUrlPath with a branch option', () => {
  let workspaceRoot: string
  let settingsRoot: string
  const branchRoot = (name: string) => path.join(workspaceRoot, 'content-branches', name)

  const contextFor = async (
    defaultBranchAccess: 'allow' | 'deny' = 'allow',
    defaultActiveBranch = 'main',
  ) => {
    const config = {
      mode: 'prod' as const,
      defaultBaseBranch: 'main',
      defaultActiveBranch,
      defaultBranchAccess,
      defaultPathAccess: 'allow' as const,
      schema,
    }
    const services = await createTestServices(config, {
      getSettingsBranchRoot: () => Promise.resolve(settingsRoot),
    })
    const ctx = await createCanopyContext({ services, extractUser: async () => USER }).getContext()
    return { ctx, services }
  }

  const addBranch = async (name: string, title: string, access: BranchAccessControl = {}) => {
    const { services } = await contextFor()
    await new BranchWorkspaceManager(services.config).openOrCreateBranch({
      branchName: name,
      mode: 'prod',
      access,
      createdBy: 'someone-else',
    })
    const postsDir = path.join(branchRoot(name), 'content/posts')
    await fs.mkdir(postsDir, { recursive: true })
    await fs.writeFile(
      path.join(postsDir, 'post.hello.RRMDbToFJNTf.json'),
      JSON.stringify({ title }),
    )
    provisioned.length = 0
  }

  const exists = (p: string) =>
    fs.access(p).then(
      () => true,
      () => false,
    )

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-read-branch-'))
    settingsRoot = path.join(workspaceRoot, 'settings')
    await fs.mkdir(settingsRoot, { recursive: true })
    vi.stubEnv('CANOPYCMS_WORKSPACE_ROOT', workspaceRoot)
    provisioned.length = 0
    vi.spyOn(GitManager, 'resolveCloneRemoteUrl').mockResolvedValue(
      path.join(workspaceRoot, 'remote.git'),
    )
    vi.spyOn(GitManager, 'cloneWorkspace').mockImplementation(async (_remote, workspacePath) => {
      await fs.mkdir(workspacePath, { recursive: true })
    })
    vi.spyOn(GitManager.prototype, 'checkoutFreshClone').mockImplementation(async (branch) => {
      provisioned.push(branch)
    })
    vi.spyOn(GitManager.prototype, 'ensureGitExclude').mockResolvedValue()
    await addBranch('main', 'on main')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await fs.rm(workspaceRoot, { recursive: true, force: true })
  })

  const readHello = (ctx: Awaited<ReturnType<typeof contextFor>>['ctx'], branch?: string) =>
    ctx.read<{ title: string }>({ entryPath: 'content/posts', slug: 'hello', branch })

  const expectNotFound = async (promise: Promise<unknown>) => {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ContentStoreError)
    expect((err as ContentStoreError).code).toBe('NOT_FOUND')
  }

  it('reads an existing branch the user can access', async () => {
    await addBranch('feature', 'on feature')
    const { ctx } = await contextFor()

    expect((await readHello(ctx, 'feature')).data.title).toBe('on feature')
    expect(
      (await ctx.readByUrlPath<{ title: string }>('/posts/hello', { branch: 'feature' }))?.data,
    ).toEqual({ title: 'on feature' })
  })

  it('never provisions a requested branch that does not exist, and reads it as not-found', async () => {
    for (const access of ['deny', 'allow'] as const) {
      const { ctx } = await contextFor(access)

      const read = readHello(ctx, 'never-created')
      const byUrl = ctx.readByUrlPath('/posts/hello', { branch: 'never-created' })
      await Promise.allSettled([read, byUrl])

      expect(provisioned).toEqual([])
      expect(await exists(branchRoot('never-created'))).toBe(false)
      await expectNotFound(read)
      expect(await byUrl).toBeNull()
    }
  })

  it('still provisions through the editor’s branch-create path, after which the branch reads', async () => {
    const { ctx, services } = await contextFor()
    await expectNotFound(readHello(ctx, 'feature'))

    // What api/branch.ts's createBranchHandler calls.
    await new BranchWorkspaceManager(services.config).openOrCreateBranch({
      branchName: 'feature',
      mode: 'prod',
      createdBy: USER.userId,
    })
    expect(provisioned).toEqual(['feature'])
    const postsDir = path.join(branchRoot('feature'), 'content/posts')
    await fs.mkdir(postsDir, { recursive: true })
    await fs.writeFile(
      path.join(postsDir, 'post.hello.RRMDbToFJNTf.json'),
      JSON.stringify({ title: 'created' }),
    )

    const { ctx: next } = await contextFor()
    expect((await readHello(next, 'feature')).data.title).toBe('created')
  })

  it('reads a branch the user cannot access as not-found, without reading its files', async () => {
    await addBranch('feature', 'on feature', { allowedUsers: ['someone-else'] })
    const { ctx, services } = await contextFor()
    const schemaSpy = vi.spyOn(services.branchSchemaCache, 'getSchema')
    const contentSpy = vi.spyOn(services, 'checkContentAccess')

    await expectNotFound(readHello(ctx, 'feature'))
    expect(await ctx.readByUrlPath('/posts/hello', { branch: 'feature' })).toBeNull()

    expect(schemaSpy).not.toHaveBeenCalledWith(
      branchRoot('feature'),
      expect.anything(),
      expect.anything(),
    )
    expect(contentSpy).not.toHaveBeenCalled()
  })

  it('reads an un-ACL’d branch as not-found under defaultBranchAccess "deny"', async () => {
    await addBranch('feature', 'on feature')
    const { ctx } = await contextFor('deny')

    await expectNotFound(readHello(ctx, 'feature'))
    // The base branch stays readable through the protected-base-branch grant.
    expect((await readHello(ctx)).data.title).toBe('on main')
  })

  it('reads a name that cannot name a workspace as not-found rather than failing the page', async () => {
    const { ctx } = await contextFor()
    // A file beside the workspaces, as the branch registry's branches.json is.
    await fs.writeFile(path.join(workspaceRoot, 'content-branches', 'stray.json'), '{}')

    // Over-long: past any filesystem's NAME_MAX, so loading it fails ENAMETOOLONG.
    for (const branch of ['../main', 'a'.repeat(300), 'stray.json']) {
      await expectNotFound(readHello(ctx, branch))
      expect(await ctx.readByUrlPath('/posts/hello', { branch })).toBeNull()
      expect(await ctx.listEntries({ branch })).toEqual([])
    }
    expect(provisioned).toEqual([])
  })

  it('reads the active branch for a null branch, as URLSearchParams.get gives for an absent one', async () => {
    const { ctx } = await contextFor()
    const branch = null as unknown as string

    expect((await readHello(ctx, branch)).data.title).toBe('on main')
    expect((await ctx.readByUrlPath<{ title: string }>('/posts/hello', { branch }))?.data).toEqual({
      title: 'on main',
    })
    expect((await ctx.listEntries({ branch })).map((e) => e.slug)).toEqual(['hello'])
  })

  it('reads a repeated ?branch= that arrives as an array as not-found', async () => {
    await addBranch('feature', 'on feature')
    const { ctx } = await contextFor()
    // Untyped page props hand this through as-is.
    const branch = ['feature', 'main'] as unknown as string

    await expectNotFound(readHello(ctx, branch))
    expect(await ctx.readByUrlPath('/posts/hello', { branch })).toBeNull()
  })

  it('provisions the active branch on first read, named or not', async () => {
    await fs.rm(branchRoot('main'), { recursive: true, force: true })
    const { ctx } = await contextFor()

    await expectNotFound(readHello(ctx))
    expect(provisioned).toEqual(['main'])
    expect(await exists(path.join(branchRoot('main'), '.canopy-meta/branch.json'))).toBe(true)

    await fs.rm(branchRoot('main'), { recursive: true, force: true })
    provisioned.length = 0
    const { ctx: next } = await contextFor()
    await expectNotFound(readHello(next, 'main'))
    expect(provisioned).toEqual(['main'])
  })

  it('lists nothing from an active branch the user cannot access, without reading it, and read throws FORBIDDEN', async () => {
    await addBranch('feature', 'on feature', { allowedUsers: ['someone-else'] })
    const { ctx, services } = await contextFor('allow', 'feature')
    const schemaSpy = vi.spyOn(services.branchSchemaCache, 'getSchema')

    expect(await ctx.listEntries()).toEqual([])
    expect(await ctx.buildContentTree()).toEqual([])
    expect(schemaSpy).not.toHaveBeenCalled()

    await expect(readHello(ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await ctx.readByUrlPath('/posts/hello')).toBeNull()
  })

  it('ignores the branch option at build time, reading the checkout', async () => {
    const checkout = path.join(workspaceRoot, 'checkout')
    await fs.mkdir(path.join(checkout, 'content/posts'), { recursive: true })
    await fs.writeFile(
      path.join(checkout, 'content/posts/post.hello.RRMDbToFJNTf.json'),
      JSON.stringify({ title: 'in checkout' }),
    )
    vi.spyOn(process, 'cwd').mockReturnValue(checkout)
    vi.stubEnv('CANOPY_BUILD_MODE', 'true')
    const { ctx } = await contextFor()

    expect((await readHello(ctx, 'never-created')).data.title).toBe('in checkout')
    expect(
      (await ctx.readByUrlPath<{ title: string }>('/posts/hello', { branch: '../main' }))?.data,
    ).toEqual({ title: 'in checkout' })
    expect(provisioned).toEqual([])
  })
})
