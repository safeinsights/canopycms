/**
 * GET /:branch/changes against a real branch clone, with the real path-ACL layer.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { simpleGit, type SimpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { defineCanopyTestConfig } from '../config-test'
import { flattenSchema, type PathPermission, type RootCollectionConfig } from '../config'
import { createCheckBranchAccess } from '../authorization'
import { createTestContentAccess, unsafeAsPermissionPath } from '../authorization/test-utils'
import { GitManager } from '../git-manager'
import { generateId } from '../id'
import {
  createMockApiContext,
  createMockBranchContext,
  initTestRepo,
  openBareRepo,
} from '../test-utils'
import { unsafeAsBranchName } from '../paths/test-utils'
import { mockConsole } from '../test-utils/console-spy'
import type { ApiContext, ApiRequest } from './types'
import { listBranchChanges, type BranchChangesData } from './branch-changes'

const fields = [{ name: 'title', type: 'string' as const, isTitle: true }]
const schema: RootCollectionConfig = {
  entries: [{ name: 'page', format: 'json', schema: fields }],
  collections: [
    { name: 'blog', path: 'blog', entries: [{ name: 'post', format: 'json', schema: fields }] },
    {
      name: 'private',
      path: 'private',
      entries: [{ name: 'post', format: 'json', schema: fields }],
    },
  ],
}

const BLOG = 'blog.q52DCVPuH4ga'
const PRIVATE = 'private.Kp3Lm4Nq5Rs6'
const ID = {
  home: 'aB3cD4eF5gH6',
  hello: 'zY9xW8vU7tS6',
  secret: 'mN8bV7cX6zL5',
  old: 'pQ2rS3tU4vW5',
  fresh: 'Ff4Gg5Hh6Jj7',
}
const files = {
  home: `content/page.home.${ID.home}.json`,
  hello: `content/${BLOG}/post.hello.${ID.hello}.json`,
  secret: `content/${PRIVATE}/post.secret.${ID.secret}.json`,
  old: `content/${BLOG}/post.old-news.${ID.old}.json`,
}

let tmpDir: string
let branchRoot: string
let clone: SimpleGit

const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(branchRoot, file)), { recursive: true })
  await fs.writeFile(path.join(branchRoot, file), text, 'utf8')
}
const entryJson = (title: string) => JSON.stringify({ title })

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-changes-api-')))
  const remotePath = path.join(tmpDir, 'remote.git')
  await fs.mkdir(remotePath)
  await openBareRepo(remotePath).init(true)
  const seedPath = path.join(tmpDir, 'seed')
  await fs.mkdir(seedPath)
  const seed = await initTestRepo(seedPath)
  await seed.raw(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  for (const [name, file] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(seedPath, file)), { recursive: true })
    await fs.writeFile(path.join(seedPath, file), entryJson(`Title of ${name}`), 'utf8')
  }
  await fs.writeFile(path.join(seedPath, 'README.md'), 'readme', 'utf8')
  await seed.raw(['add', '--', '.'])
  await seed.commit('base')
  await seed.addRemote('origin', remotePath)
  await seed.push('origin', 'main')
  branchRoot = path.join(tmpDir, 'feature')
  await GitManager.cloneRepo(remotePath, branchRoot, 'main')
  clone = simpleGit({ baseDir: branchRoot })
  await clone.raw(['checkout', '-q', '-b', 'feature', 'origin/main'])
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const createCtx = (
  options: {
    rules?: PathPermission[]
    branchAccess?: 'allow' | 'deny'
    branchName?: string
    /** The schema now, for a branch that changed it. */
    currentSchema?: RootCollectionConfig
    git?: (repoPath: string) => GitManager
  } = {},
): ApiContext => {
  const config = defineCanopyTestConfig({ defaultBranchAccess: 'allow', schema })
  const current = options.currentSchema ?? schema
  const checkBranchAccess = createCheckBranchAccess(options.branchAccess ?? 'allow')
  const access = createTestContentAccess({
    checkBranchAccess,
    loadPathPermissions: vi.fn().mockResolvedValue(options.rules ?? []),
    defaultPathAccess: 'allow',
    mode: 'dev',
    getSettingsBranchRoot: () => Promise.resolve(branchRoot),
  })
  const branchContext = createMockBranchContext({
    branchName: options.branchName ?? 'feature',
    baseRoot: tmpDir,
    branchRoot,
    createdBy: 'creator',
  })
  branchContext.branch.baseBranch = 'main'
  return createMockApiContext({
    services: {
      config,
      checkBranchAccess,
      ...access,
      createGitManagerFor: (repoPath, opts) =>
        options.git?.(repoPath) ??
        new GitManager({ repoPath, baseBranch: opts?.baseBranch ?? 'main', remote: 'origin' }),
    },
    branchContext: { ...branchContext, flatSchema: flattenSchema(current, config.contentRoot) },
  })
}

const user = (groups: string[] = []): ApiRequest['user'] => ({
  type: 'authenticated',
  userId: 'u1',
  groups,
})

const changes = async (ctx: ApiContext, groups: string[] = []): Promise<BranchChangesData> => {
  const res = await listBranchChanges.handler(
    ctx,
    { user: user(groups) },
    { branch: unsafeAsBranchName('feature') },
  )
  expect(res).toMatchObject({ ok: true, status: 200 })
  return res.data!
}

const insidersOnly: PathPermission[] = [
  { path: unsafeAsPermissionPath('content/private/**'), read: { allowedGroups: ['insiders'] } },
]

describe('GET /:branch/changes', () => {
  it('lists a working-tree save with nothing committed', async () => {
    await write(files.hello, entryJson('Edited'))
    const data = await changes(createCtx())
    expect(data).toMatchObject({ base: 'main', hiddenChanges: false, collections: [] })
    expect(data.mergeBaseSha).toMatch(/^[0-9a-f]{40}$/)
    expect(data.entries).toEqual([
      {
        status: 'modified',
        logicalPath: 'content/blog/hello',
        contentId: ID.hello,
        collectionPath: 'content/blog',
        entryType: 'post',
      },
    ])
    expect(data.otherFiles).toBeUndefined()
  })

  it('lists added, committed-modified, deleted with its base title, and moved entries, sorted', async () => {
    await write(`content/${BLOG}/post.fresh.${ID.fresh}.json`, entryJson('Fresh'))
    await write(files.home, entryJson('Home edited'))
    await clone.raw(['commit', '-qam', 'edit home'])
    await fs.rm(path.join(branchRoot, files.old))
    await fs.rename(
      path.join(branchRoot, files.hello),
      path.join(branchRoot, `content/${BLOG}/post.hello-again.${ID.hello}.json`),
    )
    const data = await changes(createCtx())
    expect(
      data.entries.map((e) => [e.status, e.logicalPath, e.previousLogicalPath, e.title]),
    ).toEqual([
      ['added', 'content/blog/fresh', undefined, undefined],
      ['moved', 'content/blog/hello-again', 'content/blog/hello', undefined],
      ['deleted', 'content/blog/old-news', undefined, 'Title of old'],
      ['modified', 'content/home', undefined, undefined],
    ])
  })

  it('treats an entry under another entry type at the same path as modified', async () => {
    const changed = `content/${BLOG}/post.hello.${ID.hello}.json`
    await fs.rm(path.join(branchRoot, changed))
    // Same slug and id under another type: the logical path is unchanged.
    const ctx = createCtx()
    const flat = (await ctx.getBranchContext('feature'))!.flatSchema!
    const blog = flat.find(
      (item) => item.type === 'collection' && item.logicalPath === 'content/blog',
    )
    if (blog?.type === 'collection') {
      blog.entries = [...(blog.entries ?? []), { name: 'note', format: 'json', schema: fields }]
    }
    await write(`content/${BLOG}/note.hello.${ID.hello}.json`, entryJson('Now a note'))
    const data = await changes(ctx)
    expect(data.entries).toEqual([
      expect.objectContaining({
        status: 'modified',
        logicalPath: 'content/blog/hello',
        entryType: 'note',
      }),
    ])
  })

  it('drops entries a path rule hides and says something is hidden, with no count', async () => {
    await write(files.secret, entryJson('Leaked?'))
    await write(files.hello, entryJson('Edited'))
    const hidden = await changes(createCtx({ rules: insidersOnly }))
    expect(hidden.entries.map((e) => e.logicalPath)).toEqual(['content/blog/hello'])
    expect(hidden.hiddenChanges).toBe(true)
    expect(JSON.stringify(hidden)).not.toContain('secret')

    const insider = await changes(createCtx({ rules: insidersOnly }), ['insiders'])
    expect(insider.entries.map((e) => e.logicalPath)).toEqual([
      'content/blog/hello',
      'content/private/secret',
    ])
    expect(insider.hiddenChanges).toBe(false)
  })

  it('shows only the readable side of a move, never the hidden path', async () => {
    const intoPrivate = `content/${PRIVATE}/post.hello.${ID.hello}.json`
    await fs.rename(path.join(branchRoot, files.hello), path.join(branchRoot, intoPrivate))
    const outsider = await changes(createCtx({ rules: insidersOnly }))
    expect(outsider.entries).toEqual([
      expect.objectContaining({ status: 'deleted', logicalPath: 'content/blog/hello' }),
    ])
    expect(outsider.hiddenChanges).toBe(true)

    const outOfPrivate = `content/${BLOG}/post.secret.${ID.secret}.json`
    await fs.rename(path.join(branchRoot, intoPrivate), path.join(branchRoot, files.hello))
    await fs.rename(path.join(branchRoot, files.secret), path.join(branchRoot, outOfPrivate))
    const again = await changes(createCtx({ rules: insidersOnly }))
    expect(again.entries).toEqual([
      expect.objectContaining({ status: 'added', logicalPath: 'content/blog/secret' }),
    ])
    expect(again.entries[0].previousLogicalPath).toBeUndefined()
    expect(again.hiddenChanges).toBe(true)

    const insider = await changes(createCtx({ rules: insidersOnly }), ['insiders'])
    expect(insider.entries).toEqual([
      expect.objectContaining({
        status: 'moved',
        logicalPath: 'content/blog/secret',
        previousLogicalPath: 'content/private/secret',
      }),
    ])
  })

  it('reports collection settings, and hides a collection the user cannot read', async () => {
    await write('content/.collection.json', '{"name":"content"}')
    await write(`content/${PRIVATE}/.collection.json`, '{"name":"private"}')
    const data = await changes(createCtx({ rules: insidersOnly }))
    expect(data.collections).toEqual([{ status: 'added', logicalPath: 'content' }])
    expect(data.hiddenChanges).toBe(true)
  })

  it('lists other files to admins only, never canopycms state', async () => {
    await write('README.md', 'changed')
    await write('.canopy-meta/branch.json', '{}')
    await clone.raw(['add', '-f', '--', '.canopy-meta/branch.json'])
    expect((await changes(createCtx())).otherFiles).toBeUndefined()
    const admin = await changes(createCtx(), ['Admins'])
    expect(admin.otherFiles).toEqual(['README.md'])
    expect(admin.entries).toEqual([])
  })

  it('answers an empty list on the protected base branch', async () => {
    await write(files.hello, entryJson('Edited'))
    const ctx = createCtx({ branchName: 'main' })
    const res = await listBranchChanges.handler(
      ctx,
      { user: user() },
      { branch: unsafeAsBranchName('main') },
    )
    expect(res).toEqual({
      ok: true,
      status: 200,
      data: { base: 'main', entries: [], collections: [], hiddenChanges: false },
    })
  })

  it('refuses with 409 while a rebase is in progress', async () => {
    await fs.mkdir(path.join(branchRoot, '.git', 'rebase-merge'))
    const res = await listBranchChanges.handler(
      createCtx(),
      { user: user() },
      { branch: unsafeAsBranchName('feature') },
    )
    expect(res).toEqual({
      ok: false,
      status: 409,
      error: 'This branch is being synced with main. Try again in a moment.',
    })
  })

  it('says the base is unavailable when the branch shares no history with it', async () => {
    await clone.raw(['checkout', '-q', '--orphan', 'unrelated'])
    await clone.raw(['commit', '-q', '-m', 'unrelated root'])
    const data = await changes(createCtx())
    expect(data).toEqual({
      base: 'main',
      entries: [],
      collections: [],
      hiddenChanges: false,
      baseUnavailable: true,
    })
  })

  it('refuses a user without branch access with 403', async () => {
    const res = await listBranchChanges.handler(
      createCtx({ branchAccess: 'deny' }),
      { user: user() },
      { branch: unsafeAsBranchName('feature') },
    )
    expect(res).toMatchObject({ ok: false, status: 403 })
  })
})

describe('GET /:branch/changes: entries the schema no longer places', () => {
  const withoutBlog: RootCollectionConfig = {
    ...schema,
    collections: schema.collections?.filter((c) => c.name !== 'blog'),
  }

  it('reads a renamed collection’s entries as moved', async () => {
    const renamed: RootCollectionConfig = {
      ...schema,
      collections: schema.collections?.map((c) =>
        c.name === 'blog' ? { ...c, name: 'journal', path: 'journal' } : c,
      ),
    }
    await fs.rename(
      path.join(branchRoot, 'content', BLOG),
      path.join(branchRoot, 'content', BLOG.replace('blog', 'journal')),
    )
    const data = await changes(createCtx({ currentSchema: renamed }))
    expect(data.entries.map((e) => [e.status, e.logicalPath, e.previousLogicalPath])).toEqual([
      ['moved', 'content/journal/hello', 'content/blog/hello'],
      ['moved', 'content/journal/old-news', 'content/blog/old-news'],
    ])
    expect(data.hiddenChanges).toBe(false)
  })

  it('reads a deleted collection’s entries as deleted, with their titles', async () => {
    await fs.rm(path.join(branchRoot, 'content', BLOG), { recursive: true })
    const data = await changes(createCtx({ currentSchema: withoutBlog }))
    expect(data.entries.map((e) => [e.status, e.logicalPath, e.title])).toEqual([
      ['deleted', 'content/blog/hello', 'Title of hello'],
      ['deleted', 'content/blog/old-news', 'Title of old'],
    ])
  })

  it('reads an entry of a removed entry type, once deleted, as deleted', async () => {
    const noPosts: RootCollectionConfig = {
      ...schema,
      collections: schema.collections?.map((c) =>
        c.name === 'blog'
          ? { ...c, entries: [{ name: 'article', format: 'json' as const, schema: fields }] }
          : c,
      ),
    }
    await fs.rm(path.join(branchRoot, files.old))
    const data = await changes(createCtx({ currentSchema: noPosts }))
    expect(data.entries).toEqual([
      expect.objectContaining({
        status: 'deleted',
        logicalPath: 'content/blog/old-news',
        entryType: 'post',
        title: 'Title of old',
      }),
    ])
  })

  it('applies path rules to the path a deleted collection’s entries had', async () => {
    await fs.rm(path.join(branchRoot, 'content', PRIVATE), { recursive: true })
    const noPrivate: RootCollectionConfig = {
      ...schema,
      collections: schema.collections?.filter((c) => c.name !== 'private'),
    }
    const data = await changes(createCtx({ currentSchema: noPrivate, rules: insidersOnly }))
    expect(data.entries).toEqual([])
    expect(data.hiddenChanges).toBe(true)
  })

  it('tells a non-admin a content file it can’t place exists, and lists it to an admin', async () => {
    await write('content/notes.txt', 'loose file')
    const editor = await changes(createCtx())
    expect(editor.entries).toEqual([])
    expect(editor.hiddenChanges).toBe(true)
    expect(editor.otherFiles).toBeUndefined()
    const admin = await changes(createCtx(), ['Admins'])
    expect(admin.otherFiles).toEqual(['content/notes.txt'])
    expect(admin.hiddenChanges).toBe(false)
  })
})

describe('GET /:branch/changes: reads that race or fail', () => {
  /** A GitManager that runs `during` once the diff has been read. */
  const gitThat = (during: () => Promise<void>) => (repoPath: string) =>
    new (class extends GitManager {
      async diffNameStatusAgainst(rev: string) {
        const result = await super.diffNameStatusAgainst(rev)
        await during()
        return result
      }
    })({ repoPath, baseBranch: 'main', remote: 'origin' })

  const syncing = {
    ok: false,
    status: 409,
    error: 'This branch is being synced with main. Try again in a moment.',
  }

  it('refuses with 409, saying the branch changed, when HEAD moves during the read', async () => {
    await write(files.hello, entryJson('Edited'))
    const ctx = createCtx({
      git: gitThat(() =>
        clone.raw(['commit', '-q', '--allow-empty', '-m', 'submitted']).then(() => {}),
      ),
    })
    const res = await listBranchChanges.handler(
      ctx,
      { user: user() },
      { branch: unsafeAsBranchName('feature') },
    )
    expect(res).toEqual({
      ok: false,
      status: 409,
      error: 'This branch changed while its changes were being read. Try again in a moment.',
    })
  })

  it('refuses with 409 when a rebase starts during the read', async () => {
    const ctx = createCtx({
      git: gitThat(() => fs.mkdir(path.join(branchRoot, '.git', 'rebase-merge'))),
    })
    const res = await listBranchChanges.handler(
      ctx,
      { user: user() },
      { branch: unsafeAsBranchName('feature') },
    )
    expect(res).toEqual(syncing)
  })

  it('answers 503, not an empty list, when git fails, and logs why', async () => {
    const consoleSpy = mockConsole()
    onTestFinished(() => consoleSpy.restore())
    await fs.rm(path.join(tmpDir, 'remote.git'), { recursive: true, force: true })
    const res = await listBranchChanges.handler(
      createCtx(),
      { user: user() },
      { branch: unsafeAsBranchName('feature') },
    )
    expect(res).toEqual({
      ok: false,
      status: 503,
      error: "Couldn't read this branch's changes right now. Try again in a moment.",
    })
    expect(consoleSpy).toHaveWarned(/could not read what feature changes against main/)
  })

  it('says the base is missing, not a failure to retry, when the remote lost the base branch', async () => {
    await openBareRepo(path.join(tmpDir, 'remote.git')).raw(['update-ref', '-d', 'refs/heads/main'])
    expect(await changes(createCtx())).toEqual({
      base: 'main',
      entries: [],
      collections: [],
      hiddenChanges: false,
      baseMissing: true,
    })
  })

  it('lists files sharing a content id as they are, never as one move', async () => {
    const copy = `content/${BLOG}/post.copy.${ID.hello}.json`
    const again = `content/${BLOG}/post.hello-again.${ID.hello}.json`
    await fs.copyFile(path.join(branchRoot, files.hello), path.join(branchRoot, copy))
    await fs.rename(path.join(branchRoot, files.hello), path.join(branchRoot, again))
    const data = await changes(createCtx())
    expect(data.entries.map((e) => [e.status, e.logicalPath, e.previousLogicalPath])).toEqual([
      ['added', 'content/blog/copy', undefined],
      ['deleted', 'content/blog/hello', undefined],
      ['added', 'content/blog/hello-again', undefined],
    ])
  })
})

describe('GET /:branch/changes: caps', () => {
  it('reads at most 200 deleted titles and lists at most 200 other files, saying so', async () => {
    for (let i = 0; i < 201; i++) {
      const id = generateId()
      await write(
        `content/${BLOG}/post.cap-${String(i).padStart(3, '0')}.${id}.json`,
        entryJson(`Cap ${i}`),
      )
    }
    await clone.raw(['add', '--', 'content'])
    await clone.raw(['commit', '-qm', 'caps'])
    await clone.raw(['push', '-q', 'origin', 'HEAD:main'])
    await fs.rm(path.join(branchRoot, 'content', BLOG), { recursive: true })
    await fs.mkdir(path.join(branchRoot, 'content', BLOG))
    for (let i = 0; i < 201; i++) await write(`other/f${String(i).padStart(3, '0')}.txt`, 'x')

    const data = await changes(createCtx(), ['Admins'])
    const deleted = data.entries.filter((e) => e.status === 'deleted')
    expect(deleted).toHaveLength(203)
    expect(deleted.filter((e) => e.title !== undefined)).toHaveLength(200)
    expect(data.otherFiles).toHaveLength(200)
    expect(data.otherFilesTruncated).toBe(true)
    expect((await changes(createCtx())).otherFilesTruncated).toBeUndefined()
  }, 60_000)
})
