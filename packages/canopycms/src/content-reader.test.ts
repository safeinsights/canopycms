import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { simpleGit } from 'simple-git'

import { createContentReader } from './content-reader'
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
      schema: [
        {
          type: 'entry',
          name: 'home',
          path: 'home',
          format: 'json',
          fields: [{ name: 'hero', type: 'object', fields: [{ name: 'title', type: 'string' }] }],
        },
        {
          type: 'collection',
          name: 'posts',
          path: 'posts',
          format: 'json',
          fields: [{ name: 'title', type: 'string' }],
        },
      ],
    })
    const branchContext = buildBranchContext(root)
    const reader = createContentReader({
      config,
      allowCreateBranch: false,
      getBranchContext: async (branch) => (branch === 'main' ? branchContext : null),
    })

    const home = await reader.read<{ hero: { title: string } }>({
      entryPath: 'content/home',
      branch: 'main',
      user: ANONYMOUS_USER,
    })
    expect(home.path).toBe('/?branch=main')
    expect(home.data.hero.title).toBe('Hi')

    await expect(
      reader.read({ entryPath: 'content/posts', slug: 'missing', user: ANONYMOUS_USER }),
    ).rejects.toBeInstanceOf(ContentStoreError)
  })

  it('readDataOrThrow returns data and throws on missing content', async () => {
    const root = await tmpDir()
    const homePath = path.join(root, 'content/home.json')
    await fs.mkdir(path.dirname(homePath), { recursive: true })
    await fs.writeFile(homePath, JSON.stringify({ hero: { title: 'Hello' } }, null, 2), 'utf8')

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      defaultPathAccess: 'allow',
      schema: [
        {
          type: 'entry',
          name: 'home',
          path: 'home',
          format: 'json',
          fields: [{ name: 'hero', type: 'object', fields: [{ name: 'title', type: 'string' }] }],
        },
        {
          type: 'collection',
          name: 'posts',
          path: 'posts',
          format: 'json',
          fields: [{ name: 'title', type: 'string' }],
        },
      ],
    })
    const branchContext = buildBranchContext(root)
    const reader = createContentReader({
      config,
      allowCreateBranch: false,
      getBranchContext: async () => branchContext,
    })

    const { data } = await reader.read<{ hero: { title: string } }>({
      entryPath: 'content/home',
      user: ANONYMOUS_USER,
    })
    expect(data.hero.title).toBe('Hello')

    await expect(
      reader.read({ entryPath: 'content/posts', slug: 'missing', user: ANONYMOUS_USER }),
    ).rejects.toBeInstanceOf(ContentStoreError)
  })

  it('enforces branch access checks', async () => {
    const root = await tmpDir()
    await fs.mkdir(path.join(root, 'content'), { recursive: true })
    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'deny',
      schema: [
        {
          type: 'entry',
          name: 'home',
          path: 'home',
          format: 'json',
          fields: [{ name: 'title', type: 'string' }],
        },
      ],
    })
    const branchContext = buildBranchContext(root)
    const reader = createContentReader({
      config,
      allowCreateBranch: false,
      getBranchContext: async () => branchContext,
    })

    await expect(
      reader.read({
        entryPath: 'content/home',
        user: { type: 'authenticated', userId: 'anon', groups: [] },
      }),
    ).rejects.toBeInstanceOf(ContentStoreError)
  })

  it('builds preview paths alongside data', async () => {
    const root = await tmpDir()
    const postsDir = path.join(root, 'content/posts')
    await fs.mkdir(postsDir, { recursive: true })
    await fs.writeFile(
      path.join(postsDir, 'first.json'),
      JSON.stringify({ title: 'Hello world' }, null, 2),
      'utf8',
    )
    await fs.writeFile(
      path.join(root, 'content/home.json'),
      JSON.stringify({ title: 'Home' }, null, 2),
      'utf8',
    )

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      defaultPathAccess: 'allow',
      schema: [
        {
          type: 'collection',
          name: 'posts',
          path: 'posts',
          format: 'json',
          fields: [{ name: 'title', type: 'string' }],
        },
        {
          type: 'entry',
          name: 'home',
          path: 'home',
          format: 'json',
          fields: [{ name: 'title', type: 'string' }],
        },
      ],
    })
    const branchContext = buildBranchContext(root)
    const reader = createContentReader({
      config,
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
    const git = simpleGit({ baseDir: root })
    await git.init()
    await git.raw(['branch', '-M', 'main'])
    await fs.mkdir(path.join(root, 'content'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'content/home.json'),
      JSON.stringify({ hero: { title: 'Welcome' } }, null, 2),
      'utf8',
    )
    await git.add(['.'])
    await git.commit('init')

    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      defaultPathAccess: 'allow',
      mode: 'local-simple',
      schema: [
        {
          type: 'entry',
          name: 'home',
          path: 'home',
          format: 'json',
          fields: [{ name: 'hero', type: 'object', fields: [{ name: 'title', type: 'string' }] }],
        },
      ],
    })

    const reader = createContentReader({ config, basePathOverride: root })
    const doc = await reader.read<{ hero: { title: string } }>({
      entryPath: 'content/home',
      user: ANONYMOUS_USER,
    })
    expect(doc.path).toBe('/?branch=main')
    expect(doc.data.hero.title).toBe('Welcome')

    const metaPath = path.join(root, '.canopycms/branch.json')
    const metaRaw = await fs.readFile(metaPath, 'utf8')
    const meta = JSON.parse(metaRaw)
    expect(meta.branch.name).toBe('main')
    expect(meta.branch.createdBy).toBe('canopycms-content-reader')
  })
})
