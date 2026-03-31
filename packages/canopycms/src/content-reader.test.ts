import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'
import { simpleGit } from 'simple-git'

import { createContentReader } from './content-reader'
import { createTestServices } from './config-test'
import { defineCanopyTestConfig } from './config-test'
import { ANONYMOUS_USER } from './user'
import type { BranchContext } from './types'
import { ContentStoreError } from './content-store'
import { unsafeAsLogicalPath, unsafeAsEntrySlug } from './paths/test-utils'

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
    const pagesDir = path.join(root, 'content/pages')
    const postsDir = path.join(root, 'content/posts')
    await fs.mkdir(pagesDir, { recursive: true })
    await fs.mkdir(postsDir, { recursive: true })
    await fs.writeFile(
      path.join(pagesDir, 'home.json'),
      JSON.stringify({ hero: { title: 'Hi' } }, null, 2),
      'utf8',
    )

    const schema = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [
            {
              name: 'post',
              format: 'json' as const,
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
        {
          name: 'pages',
          path: 'pages',
          entries: [
            {
              name: 'page',
              format: 'json' as const,
              schema: [
                {
                  name: 'hero',
                  type: 'object' as const,
                  fields: [{ name: 'title', type: 'string' as const }],
                },
              ],
            },
          ],
        },
      ],
    }
    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      defaultPathAccess: 'allow',
      schema,
    })
    const branchContext = buildBranchContext(root)
    const reader = createContentReader({
      services: await createTestServices(
        { ...config, schema },
        { getSettingsBranchRoot: () => Promise.resolve(root) },
      ),
      allowCreateBranch: false,
      getBranchContext: async (branch) => (branch === 'main' ? branchContext : null),
    })

    const home = await reader.read<{ hero: { title: string } }>({
      entryPath: unsafeAsLogicalPath('content/pages'),
      slug: unsafeAsEntrySlug('home'),
      branch: 'main',
      user: ANONYMOUS_USER,
    })
    expect(home.path).toBe('/pages/home?branch=main')
    expect(home.data.hero.title).toBe('Hi')

    await expect(
      reader.read({
        entryPath: unsafeAsLogicalPath('content/posts'),
        slug: unsafeAsEntrySlug('missing'),
        user: ANONYMOUS_USER,
      }),
    ).rejects.toBeInstanceOf(ContentStoreError)
  })

  it('readDataOrThrow returns data and throws on missing content', async () => {
    const root = await tmpDir()
    const pagesDir = path.join(root, 'content/pages')
    await fs.mkdir(pagesDir, { recursive: true })
    await fs.writeFile(
      path.join(pagesDir, 'home.json'),
      JSON.stringify({ hero: { title: 'Hello' } }, null, 2),
      'utf8',
    )

    const schema = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [
            {
              name: 'post',
              format: 'json' as const,
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
        {
          name: 'pages',
          path: 'pages',
          entries: [
            {
              name: 'page',
              format: 'json' as const,
              schema: [
                {
                  name: 'hero',
                  type: 'object' as const,
                  fields: [{ name: 'title', type: 'string' as const }],
                },
              ],
            },
          ],
        },
      ],
    }
    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      defaultPathAccess: 'allow',
      schema,
    })
    const branchContext = buildBranchContext(root)
    const reader = createContentReader({
      services: await createTestServices(
        { ...config, schema },
        { getSettingsBranchRoot: () => Promise.resolve(root) },
      ),
      allowCreateBranch: false,
      getBranchContext: async () => branchContext,
    })

    const { data } = await reader.read<{ hero: { title: string } }>({
      entryPath: unsafeAsLogicalPath('content/pages'),
      slug: unsafeAsEntrySlug('home'),
      user: ANONYMOUS_USER,
    })
    expect(data.hero.title).toBe('Hello')

    await expect(
      reader.read({
        entryPath: unsafeAsLogicalPath('content/posts'),
        slug: unsafeAsEntrySlug('missing'),
        user: ANONYMOUS_USER,
      }),
    ).rejects.toBeInstanceOf(ContentStoreError)
  })

  it('enforces branch access checks', async () => {
    const root = await tmpDir()
    const pagesDir = path.join(root, 'content/pages')
    await fs.mkdir(pagesDir, { recursive: true })
    const schema = {
      collections: [
        {
          name: 'pages',
          path: 'pages',
          entries: [
            {
              name: 'page',
              format: 'json' as const,
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
      ],
    }
    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'deny',
      schema,
    })
    const branchContext = buildBranchContext(root)
    const reader = createContentReader({
      services: await createTestServices(
        { ...config, schema },
        { getSettingsBranchRoot: () => Promise.resolve(root) },
      ),
      allowCreateBranch: false,
      getBranchContext: async () => branchContext,
    })

    await expect(
      reader.read({
        entryPath: unsafeAsLogicalPath('content/pages'),
        slug: unsafeAsEntrySlug('home'),
        user: { type: 'authenticated', userId: 'anon', groups: [] },
      }),
    ).rejects.toBeInstanceOf(ContentStoreError)
  })

  it('builds preview paths alongside data', async () => {
    const root = await tmpDir()
    const postsDir = path.join(root, 'content/posts')
    const pagesDir = path.join(root, 'content/pages')
    await fs.mkdir(postsDir, { recursive: true })
    await fs.mkdir(pagesDir, { recursive: true })
    // Create files with embedded IDs: {type}.{slug}.{id}.{ext}
    // IDs must be valid Base58 (12 chars, excludes 0, O, I, l)
    await fs.writeFile(
      path.join(postsDir, 'post.first.abc123def456.json'),
      JSON.stringify({ title: 'Hello world' }, null, 2),
      'utf8',
    )
    await fs.writeFile(
      path.join(pagesDir, 'page.home.xyz789uvwABC.json'),
      JSON.stringify({ title: 'Home' }, null, 2),
      'utf8',
    )

    const schema = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [
            {
              name: 'post',
              format: 'json' as const,
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
        {
          name: 'pages',
          path: 'pages',
          entries: [
            {
              name: 'page',
              format: 'json' as const,
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
      ],
    }
    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      defaultPathAccess: 'allow',
      defaultBaseBranch: 'main',
      schema,
    })
    const branchContext = buildBranchContext(root)
    const reader = createContentReader({
      services: await createTestServices(
        { ...config, schema },
        { getSettingsBranchRoot: () => Promise.resolve(root) },
      ),
      allowCreateBranch: false,
      getBranchContext: async () => branchContext,
    })

    const post = await reader.read<{ title: string }>({
      entryPath: unsafeAsLogicalPath('content/posts'),
      slug: unsafeAsEntrySlug('first'),
      user: ANONYMOUS_USER,
    })
    expect(post.data.title).toBe('Hello world')
    expect(post.path).toBe('/posts/first?branch=main')

    const page = await reader.read<{ title: string }>({
      entryPath: unsafeAsLogicalPath('content/pages'),
      slug: unsafeAsEntrySlug('home'),
      branch: 'feature/foo',
      user: ANONYMOUS_USER,
    })
    expect(page.path).toBe('/pages/home?branch=feature%2Ffoo')
  })

  it('creates the branch workspace when missing', async () => {
    const root = await tmpDir()
    // Mock process.cwd() to isolate test from parent git repo
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)

    const git = simpleGit({ baseDir: root })
    await git.init()
    await git.raw(['branch', '-M', 'main'])
    await fs.mkdir(path.join(root, 'content/pages'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'content/pages/home.json'),
      JSON.stringify({ hero: { title: 'Welcome' } }, null, 2),
      'utf8',
    )
    await git.add(['.'])
    await git.commit('init')

    const schema = {
      collections: [
        {
          name: 'pages',
          path: 'pages',
          entries: [
            {
              name: 'page',
              format: 'json' as const,
              schema: [
                {
                  name: 'hero',
                  type: 'object' as const,
                  fields: [{ name: 'title', type: 'string' as const }],
                },
              ],
            },
          ],
        },
      ],
    }
    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      defaultPathAccess: 'allow',
      mode: 'dev',
      schema,
    })

    try {
      const reader = createContentReader({
        services: await createTestServices(
          { ...config, schema },
          { getSettingsBranchRoot: () => Promise.resolve(root) },
        ),
        basePathOverride: root,
      })
      const doc = await reader.read<{ hero: { title: string } }>({
        entryPath: unsafeAsLogicalPath('content/pages'),
        slug: unsafeAsEntrySlug('home'),
        user: ANONYMOUS_USER,
      })
      expect(doc.path).toBe('/pages/home?branch=main')
      expect(doc.data.hero.title).toBe('Welcome')

      // In dev mode, workspace is at .canopy-dev/content-branches/main
      const metaPath = path.join(root, '.canopy-dev/content-branches/main/.canopy-meta/branch.json')
      const metaRaw = await fs.readFile(metaPath, 'utf8')
      const meta = JSON.parse(metaRaw)
      expect(meta.branch.name).toBe('main')
      expect(meta.branch.createdBy).toBe('canopycms-content-reader')
    } finally {
      cwdSpy.mockRestore()
    }
  })

  it('merges body into data for md format entries', async () => {
    const root = await tmpDir()
    const postsDir = path.join(root, 'content/posts')
    await fs.mkdir(postsDir, { recursive: true })
    // Write a markdown file with frontmatter + body (gray-matter format)
    await fs.writeFile(
      path.join(postsDir, 'post.hello.abc123def456.md'),
      '---\ntitle: Hello World\ntags:\n  - typed\n---\nSome **markdown** content.\n',
      'utf8',
    )

    const schema = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [
            {
              name: 'post',
              format: 'md' as const,
              schema: [
                { name: 'title', type: 'string' as const },
                { name: 'tags', type: 'string' as const, list: true },
              ],
            },
          ],
        },
      ],
    }
    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      defaultPathAccess: 'allow',
      schema,
    })
    const branchContext = buildBranchContext(root)
    const reader = createContentReader({
      services: await createTestServices(
        { ...config, schema },
        { getSettingsBranchRoot: () => Promise.resolve(root) },
      ),
      allowCreateBranch: false,
      getBranchContext: async () => branchContext,
    })

    const result = await reader.read<{
      title: string
      tags: string[]
      body: string
    }>({
      entryPath: unsafeAsLogicalPath('content/posts'),
      slug: unsafeAsEntrySlug('hello'),
      user: ANONYMOUS_USER,
    })

    expect(result.data.title).toBe('Hello World')
    expect(result.data.tags).toEqual(['typed'])
    expect(result.data.body).toContain('Some **markdown** content.')
  })

  it('checks permissions BEFORE reading file (security)', async () => {
    const root = await tmpDir()
    const pagesDir = path.join(root, 'content/pages')
    await fs.mkdir(pagesDir, { recursive: true })
    await fs.writeFile(
      path.join(pagesDir, 'home.json'),
      JSON.stringify({ title: 'Secret' }, null, 2),
      'utf8',
    )

    const schema = {
      collections: [
        {
          name: 'pages',
          path: 'pages',
          entries: [
            {
              name: 'page',
              format: 'json' as const,
              schema: [{ name: 'title', type: 'string' as const }],
            },
          ],
        },
      ],
    }
    const config = defineCanopyTestConfig({
      defaultBranchAccess: 'allow',
      defaultPathAccess: 'deny', // Deny by default
      schema,
    })

    const branchContext = buildBranchContext(root)
    const reader = createContentReader({
      services: await createTestServices(
        { ...config, schema },
        { getSettingsBranchRoot: () => Promise.resolve(root) },
      ),
      allowCreateBranch: false,
      getBranchContext: async () => branchContext,
    })

    // Spy on fs.readFile to verify content file is NOT read when permission is denied
    const readFileSpy = vi.spyOn(fs, 'readFile')

    // Attempt unauthorized read
    await expect(
      reader.read({
        entryPath: unsafeAsLogicalPath('content/pages'),
        slug: unsafeAsEntrySlug('home'),
        user: { type: 'authenticated', userId: 'unauthorized', groups: [] },
      }),
    ).rejects.toThrow(/Forbidden/)

    // CRITICAL: Content file should NOT have been accessed (permissions.json is OK)
    const contentFileCalls = readFileSpy.mock.calls.filter((call) =>
      call[0].toString().includes('content/pages/home.json'),
    )
    expect(contentFileCalls).toHaveLength(0)

    readFileSpy.mockRestore()
  })
})
