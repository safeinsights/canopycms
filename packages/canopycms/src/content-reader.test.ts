import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'
import { simpleGit } from 'simple-git'

import { createContentReader } from './content-reader'
import { createCanopyServices } from './services'
import { defineCanopyTestConfig } from './config-test'
import { ANONYMOUS_USER } from './user'
import type { BranchContext } from './types'
import { ContentStoreError } from './content-store'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-content-reader-'))

const buildBranchContext = (branchRoot: string, name = 'main'): BranchContext => {
  const now = new Date().toISOString()
  return {
    baseRoot: branchRoot,
    branchRoot,
    branch: {
      name,
      status: 'editing',
      access: {},
      createdBy: 'tester',
      createdAt: now,
      updatedAt: now,
    },
  }
}

describe('createContentReader', () => {
  it('reads content for a provided branch state and returns null when missing', async () => {
    const root = await tmpDir()
    const homePath = path.join(root, 'content/home.json')
    const postsDir = path.join(root, 'content/posts')
    await fs.mkdir(postsDir, { recursive: true })
    await fs.writeFile(homePath, JSON.stringify({ hero: { title: 'Hi' } }, null, 2), 'utf8')

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      defaultPathAccess: 'allow',
      schema: {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: { format: 'json', fields: [{ name: 'title', type: 'string' }] },
          },
        ],
        singletons: [
          {
            name: 'home',
            path: 'home',
            format: 'json',
            fields: [
              { name: 'hero', type: 'object', fields: [{ name: 'title', type: 'string' }] },
            ],
          },
        ],
      },
    })
    const branchContext = buildBranchContext(root)
    const reader = createContentReader({ services: await createCanopyServices(config, { schema: config.schema }),
      allowCreateBranch: false,
      getBranchContext: async (branch) => (branch === 'main' ? branchContext : null),
    })

    const home = await reader.read<{ hero: { title: string } }>({ entryPath: 'content/home', branch: 'main', user: ANONYMOUS_USER })
    expect(home.path).toBe('/?branch=main')
    expect(home.data.hero.title).toBe('Hi')

    await expect(reader.read({ entryPath: 'content/posts', slug: 'missing', user: ANONYMOUS_USER })).rejects.toBeInstanceOf(
      ContentStoreError
    )
  })

  it('readDataOrThrow returns data and throws on missing content', async () => {
    const root = await tmpDir()
    const homePath = path.join(root, 'content/home.json')
    await fs.mkdir(path.dirname(homePath), { recursive: true })
    await fs.writeFile(homePath, JSON.stringify({ hero: { title: 'Hello' } }, null, 2), 'utf8')

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      defaultPathAccess: 'allow',
      schema: {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: { format: 'json', fields: [{ name: 'title', type: 'string' }] },
          },
        ],
        singletons: [
          {
            name: 'home',
            path: 'home',
            format: 'json',
            fields: [
              { name: 'hero', type: 'object', fields: [{ name: 'title', type: 'string' }] },
            ],
          },
        ],
      },
    })
    const branchContext = buildBranchContext(root)
    const reader = createContentReader({ services: await createCanopyServices(config, { schema: config.schema }),
      allowCreateBranch: false,
      getBranchContext: async () => branchContext,
    })

    const { data } = await reader.read<{ hero: { title: string } }>({ entryPath: 'content/home', user: ANONYMOUS_USER })
    expect(data.hero.title).toBe('Hello')

    await expect(
      reader.read({ entryPath: 'content/posts', slug: 'missing', user: ANONYMOUS_USER })
    ).rejects.toBeInstanceOf(ContentStoreError)
  })

  it('enforces branch access checks', async () => {
    const root = await tmpDir()
    await fs.mkdir(path.join(root, 'content'), { recursive: true })
    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'deny',
      schema: {
        collections: [],
        singletons: [
          {
            name: 'home',
            path: 'home',
            format: 'json',
            fields: [{ name: 'title', type: 'string' }],
          },
        ],
      },
    })
    const branchContext = buildBranchContext(root)
    const reader = createContentReader({ services: await createCanopyServices(config, { schema: config.schema }),
      allowCreateBranch: false,
      getBranchContext: async () => branchContext,
    })

    await expect(reader.read({ entryPath: 'content/home', user: { type: 'authenticated', userId: 'anon', groups: [] } })).rejects.toBeInstanceOf(
      ContentStoreError
    )
  })

  it('builds preview paths alongside data', async () => {
    const root = await tmpDir()
    const postsDir = path.join(root, 'content/posts')
    await fs.mkdir(postsDir, { recursive: true })
    // Create files with embedded IDs (12-char Base58)
    await fs.writeFile(path.join(postsDir, 'first.abc123def456.json'), JSON.stringify({ title: 'Hello world' }, null, 2), 'utf8')
    await fs.writeFile(path.join(root, 'content/home.json'), JSON.stringify({ title: 'Home' }, null, 2), 'utf8')

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      defaultPathAccess: 'allow',
      schema: {
        collections: [
          {
            name: 'posts',
            path: 'posts',
            entries: { format: 'json', fields: [{ name: 'title', type: 'string' }] },
          },
        ],
        singletons: [
          {
            name: 'home',
            path: 'home',
            format: 'json',
            fields: [{ name: 'title', type: 'string' }],
          },
        ],
      },
    })
    const branchContext = buildBranchContext(root)
    const reader = createContentReader({ services: await createCanopyServices(config, { schema: config.schema }),
      allowCreateBranch: false,
      getBranchContext: async () => branchContext,
    })

    const post = await reader.read<{ title: string }>({
      entryPath: 'content/posts',
      slug: 'first',
      user: ANONYMOUS_USER,
    })
    expect(post.data.title).toBe('Hello world')
    expect(post.path).toBe('/posts/first?branch=main')

    const home = await reader.read<{ title: string }>({
      entryPath: 'content/home',
      branch: 'feature/foo',
      user: ANONYMOUS_USER,
    })
    expect(home.path).toBe('/?branch=feature%2Ffoo')
  })

  it('creates the branch workspace when missing', async () => {
    const root = await tmpDir()
    // Mock process.cwd() to isolate test from parent git repo
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)

    const git = simpleGit({ baseDir: root })
    await git.init()
    await git.raw(['branch', '-M', 'main'])
    await fs.mkdir(path.join(root, 'content'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'content/home.json'),
      JSON.stringify({ hero: { title: 'Welcome' } }, null, 2),
      'utf8'
    )
    await git.add(['.'])
    await git.commit('init')

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      defaultPathAccess: 'allow',
      mode: 'prod-sim',
      schema: {
        collections: [],
        singletons: [
          {
            name: 'home',
            path: 'home',
            format: 'json',
            fields: [
              { name: 'hero', type: 'object', fields: [{ name: 'title', type: 'string' }] },
            ],
          },
        ],
      },
    })

    try {
      const reader = createContentReader({ services: await createCanopyServices(config, { schema: config.schema }), basePathOverride: root })
      const doc = await reader.read<{ hero: { title: string } }>({ entryPath: 'content/home', user: ANONYMOUS_USER })
      expect(doc.path).toBe('/?branch=main')
      expect(doc.data.hero.title).toBe('Welcome')

      // In prod-sim, workspace is at .canopy-prod-sim/content-branches/main
      const metaPath = path.join(root, '.canopy-prod-sim/content-branches/main/.canopy-meta/branch.json')
      const metaRaw = await fs.readFile(metaPath, 'utf8')
      const meta = JSON.parse(metaRaw)
      expect(meta.branch.name).toBe('main')
      expect(meta.branch.createdBy).toBe('canopycms-content-reader')
    } finally {
      cwdSpy.mockRestore()
    }
  })

  it('checks permissions BEFORE reading file (security)', async () => {
    const root = await tmpDir()
    const homePath = path.join(root, 'content/home.json')
    await fs.mkdir(path.dirname(homePath), { recursive: true })
    await fs.writeFile(homePath, JSON.stringify({ title: 'Secret' }, null, 2), 'utf8')

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      defaultPathAccess: 'deny', // Deny by default
      schema: {
        collections: [],
        singletons: [
          {
            name: 'home',
            path: 'home',
            format: 'json',
            fields: [{ name: 'title', type: 'string' }],
          },
        ],
      },
    })

    const branchContext = buildBranchContext(root)
    const reader = createContentReader({ services: await createCanopyServices(config, { schema: config.schema }),
      allowCreateBranch: false,
      getBranchContext: async () => branchContext,
    })

    // Spy on fs.readFile to verify content file is NOT read when permission is denied
    const readFileSpy = vi.spyOn(fs, 'readFile')

    // Attempt unauthorized read
    await expect(
      reader.read({ entryPath: 'content/home', user: { type: 'authenticated', userId: 'unauthorized', groups: [] } })
    ).rejects.toThrow(/Forbidden/)

    // CRITICAL: Content file should NOT have been accessed (permissions.json is OK)
    const contentFileCalls = readFileSpy.mock.calls.filter((call) =>
      call[0].toString().includes('content/home.json')
    )
    expect(contentFileCalls).toHaveLength(0)

    readFileSpy.mockRestore()
  })
})
