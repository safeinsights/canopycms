import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { simpleGit } from 'simple-git'

import { createCanopyCatchAllHandler } from './api'
import { defineCanopyConfig } from '../config'
import { defineCanopyTestConfig } from '../config-test'
import { loadBranchState } from '../branch-workspace'
import { resolveBranchPath } from '../paths'

vi.mock('next/server', () => {
  const mod = {
    NextResponse: {
      json: (data: any, init?: any) => ({ ...data, status: init?.status ?? data?.status ?? 200 }),
    },
  }
  return mod as unknown
})

const encodeId = (id: string) => encodeURIComponent(id)

describe('canopycms catch-all integration', () => {
  let tmpRoot: string
  let cwdSpy: any

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-int-'))
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot)
  })

  afterEach(async () => {
    cwdSpy.mockRestore()
    await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('drives branch create, content read/write, entry listing, and submit via the catch-all route', async () => {
    const branchName = 'feature-int'
    const branchMode = 'local-prod-sim' as const
    const remotePath = path.join(tmpRoot, 'remote.git')
    const seedPath = path.join(tmpRoot, 'seed')

    // Init bare remote
    await simpleGit().raw(['init', '--bare', remotePath])

    // Seed main on remote
    await fs.mkdir(seedPath, { recursive: true })
    const seedGit = simpleGit({ baseDir: seedPath })
    await seedGit.init()
    await seedGit.raw(['branch', '-M', 'main'])
    await fs.mkdir(path.join(seedPath, 'content'), { recursive: true })
    await fs.writeFile(path.join(seedPath, 'README.md'), '# seed\n', 'utf8')
    await seedGit.add(['.'])
    await seedGit.commit('init')
    await seedGit.addRemote('origin', remotePath)
    await seedGit.push('origin', 'main', { '--set-upstream': null })

    const config = defineCanopyTestConfig({
      mode: branchMode,
      defaultBranchAccess: 'allow',
      defaultBaseBranch: 'main',
      defaultRemoteName: 'origin',
      defaultRemoteUrl: remotePath,
      gitBotAuthorName: 'Test Bot',
      gitBotAuthorEmail: 'bot@example.com',
      schema: [
        {
          type: 'collection',
          name: 'posts',
          path: 'posts',
          format: 'json',
          fields: [{ name: 'title', type: 'string' }],
        },
        {
          type: 'singleton',
          name: 'home',
          path: 'home',
          format: 'json',
          fields: [
            { name: 'hero', type: 'object', fields: [{ name: 'headline', type: 'string' }] },
          ],
        },
      ],
    })
    expect(config.mode).toBe('local-prod-sim')

    const handler = createCanopyCatchAllHandler({
      config,
      getUser: async () => ({ userId: 'tester' }),
    })

    const call = async (
      method: string,
      segments: string[],
      body?: unknown,
      query?: Record<string, string>,
    ) => {
      const search = query ? `?${new URLSearchParams(query).toString()}` : ''
      const url = `http://localhost/api${search}`
      return handler({ method, json: async () => body, url } as any, {
        params: { canopycms: segments },
      })
    }

    // Create branch
    const createBranch = await call('POST', ['branches'], { branch: branchName, title: 'Feature' })
    expect(createBranch.ok).toBe(true)
    const preSubmitState = await loadBranchState({
      branchName,
      mode: config.mode ?? 'local-simple',
    })
    const expectedPaths = resolveBranchPath({ branchName, mode: branchMode })
    expect(preSubmitState?.baseRoot).toBe(expectedPaths.baseRoot)
    expect(preSubmitState?.workspaceRoot).toBe(expectedPaths.branchRoot)
    await expect(fs.stat(path.join(preSubmitState!.workspaceRoot!, '.git'))).resolves.toBeTruthy()
    const branchGit = simpleGit({ baseDir: preSubmitState!.workspaceRoot! })
    await branchGit.addConfig('user.name', 'Test User')
    await branchGit.addConfig('user.email', 'test@example.com')

    // Write singleton content
    const homeCollectionId = 'content/home'
    const writeHome = await call('PUT', [branchName, 'content', encodeId(homeCollectionId)], {
      collection: homeCollectionId,
      format: 'json',
      data: { hero: { headline: 'Hello World' } },
    })
    expect(writeHome.ok).toBe(true)

    // Read singleton content
    const readHome = await call('GET', [branchName, 'content', encodeId(homeCollectionId)])
    expect(readHome.ok).toBe(true)
    expect(readHome.data?.data?.hero?.headline).toBe('Hello World')

    // Write collection entry
    const postsCollectionId = 'content/posts'
    const writePost = await call(
      'PUT',
      [branchName, 'content', encodeId(postsCollectionId), 'hello-world'],
      {
        collection: postsCollectionId,
        slug: 'hello-world',
        format: 'json',
        data: { title: 'Hello World' },
      },
    )
    expect(writePost.ok).toBe(true)

    // Read collection entry
    const readPost = await call('GET', [
      branchName,
      'content',
      encodeId(postsCollectionId),
      'hello-world',
    ])
    expect(readPost.ok).toBe(true)
    expect(readPost.data?.data?.title).toBe('Hello World')

    // List entries
    const entries = await call('GET', [branchName, 'entries'])
    expect(entries.ok).toBe(true)
    const entryList = entries.data?.entries ?? []
    expect(entryList.some((e: any) => e.slug === 'hello-world')).toBe(true)
    const collections = entries.data?.collections ?? []
    const postsSchema = collections.find((c: any) => c.id === postsCollectionId)?.schema
    expect(postsSchema?.length).toBeGreaterThan(0)
    const filtered = await call('GET', [branchName, 'entries'], undefined, { q: 'hello' })
    expect(filtered.ok).toBe(true)
    expect((filtered.data?.entries ?? []).length).toBe(1)

    // Submit branch and verify status
    const submit = await call('POST', [branchName, 'submit'], {})
    if (!submit.ok) {
      // Surface debug info when submit fails in CI
      // eslint-disable-next-line no-console
      console.error('submit failure', submit)
    }
    expect(submit.ok).toBe(true)
    const status = await call('GET', [branchName, 'status'])
    expect(status.data?.branch.branch.status).toBe('submitted')

    // Files were written to the branch workspace
    const state = await loadBranchState({ branchName, mode: config.mode ?? 'local-simple' })
    expect(state?.workspaceRoot).toBeTruthy()
    const homePath = path.join(state!.workspaceRoot!, 'content/home.json')
    const postPath = path.join(state!.workspaceRoot!, 'content/posts/hello-world.json')
    const homeRaw = JSON.parse(await fs.readFile(homePath, 'utf8'))
    expect(homeRaw.hero.headline).toBe('Hello World')
    const postRaw = JSON.parse(await fs.readFile(postPath, 'utf8'))
    expect(postRaw.title).toBe('Hello World')

    // Remote contains pushed commit
    const verifyPath = path.join(tmpRoot, 'verify')
    await simpleGit().clone(remotePath, verifyPath, ['--branch', branchName])
    const remoteHome = JSON.parse(
      await fs.readFile(path.join(verifyPath, 'content/home.json'), 'utf8'),
    )
    const remotePost = JSON.parse(
      await fs.readFile(path.join(verifyPath, 'content/posts/hello-world.json'), 'utf8'),
    )
    expect(remoteHome.hero.headline).toBe('Hello World')
    expect(remotePost.title).toBe('Hello World')
  })
})
