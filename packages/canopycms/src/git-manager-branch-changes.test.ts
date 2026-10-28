import childProcess from 'node:child_process'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { simpleGit, type SimpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GitManager } from './git-manager'
import { initTestRepo, openBareRepo } from './test-utils'

let tmpDir: string
let remotePath: string
let seedPath: string
let seed: SimpleGit
let clonePath: string
let clone: SimpleGit

const write = async (root: string, file: string, text: string) => {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await fs.writeFile(path.join(root, file), text, 'utf8')
}

/** Commit `files` on the seed's main and push them to the remote. */
const pushToBase = async (files: Record<string, string>): Promise<string> => {
  for (const [file, text] of Object.entries(files)) await write(seedPath, file, text)
  await seed.raw(['add', '--', '.'])
  await seed.commit('base')
  await seed.push('origin', 'main')
  return (await seed.revparse(['HEAD'])).trim()
}

/** The git subcommand of every spawn from here on, after simple-git's `-c` pairs. */
const spySubcommands = (): string[] => {
  const seen: string[] = []
  const original = childProcess.spawn
  vi.spyOn(childProcess, 'spawn').mockImplementation(((
    command: string,
    args: readonly string[],
    options: childProcess.SpawnOptions,
  ) => {
    let i = 0
    while (args[i] === '-c') i += 2
    seen.push(args[i])
    return original(command, args, options)
  }) as typeof childProcess.spawn)
  syncBuiltinESMExports()
  return seen
}

const manager = () => new GitManager({ repoPath: clonePath, baseBranch: 'main' })

beforeEach(async () => {
  tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-branch-changes-')))
  remotePath = path.join(tmpDir, 'remote.git')
  await fs.mkdir(remotePath)
  await openBareRepo(remotePath).init(true)
  seedPath = path.join(tmpDir, 'seed')
  await fs.mkdir(seedPath)
  seed = await initTestRepo(seedPath)
  await seed.raw(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await seed.addRemote('origin', remotePath)
  await pushToBase({
    'content/a.md': 'a',
    'content/b c.md': 'b',
    'content/-dash.md': 'dash',
    'other/x.md': 'x',
    'top.txt': 'top',
  })
  clonePath = path.join(tmpDir, 'clone')
  await GitManager.cloneRepo(remotePath, clonePath, 'main')
  clone = simpleGit({ baseDir: clonePath })
  await clone.addConfig('user.name', 'Test Bot')
  await clone.addConfig('user.email', 'test@canopycms.test')
  await clone.raw(['checkout', '-q', '-b', 'feature', 'origin/main'])
})

afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('GitManager.mergeBaseWithBase', () => {
  it("is the base's tip for a fresh single-branch clone, read without a fetch", async () => {
    const tip = (await seed.revparse(['HEAD'])).trim()
    expect((await clone.raw(['rev-parse', 'refs/remotes/origin/main'])).trim()).toBe(tip)
    const spawned = spySubcommands()
    expect(await manager().mergeBaseWithBase()).toBe(tip)
    expect(spawned).toContain('ls-remote')
    expect(spawned).not.toContain('fetch')
  })

  it('follows a rebase onto a base fetched by path, which leaves the tracking ref behind', async () => {
    const oldTip = (await seed.revparse(['HEAD'])).trim()
    await write(clonePath, 'content/a.md', 'branch edit')
    await clone.raw(['commit', '-qam', 'edit'])
    const newTip = await pushToBase({ 'content/new.md': 'new' })
    // The worker's fetch: by path, then a rebase onto the fetched tip.
    await clone.raw(['fetch', '-q', remotePath, 'main'])
    await clone.raw(['rebase', '-q', newTip])
    expect((await clone.raw(['rev-parse', 'refs/remotes/origin/main'])).trim()).toBe(oldTip)

    const spawned = spySubcommands()
    expect(await manager().mergeBaseWithBase()).toBe(newTip)
    expect(spawned).not.toContain('fetch')
  })

  it("fetches when this clone lacks the base's tip, then forks from it", async () => {
    const newTip = await pushToBase({ 'content/new.md': 'new' })
    const spawned = spySubcommands()
    // HEAD forked at the old tip, which is an ancestor of the new one.
    const oldTip = (await clone.revparse(['HEAD'])).trim()
    expect(await manager().mergeBaseWithBase()).toBe(oldTip)
    expect(spawned).toContain('fetch')
    expect((await clone.raw(['cat-file', '-t', newTip])).trim()).toBe('commit')
  })

  it('fetches objects only, moving no ref and writing no FETCH_HEAD', async () => {
    const trackingBefore = (await clone.raw(['rev-parse', 'refs/remotes/origin/main'])).trim()
    const refsBefore = await clone.raw(['for-each-ref'])
    const fetchHead = path.join(clonePath, '.git', 'FETCH_HEAD')
    await fs.writeFile(fetchHead, 'pinned by another fetch\n', 'utf8')
    await pushToBase({ 'content/new.md': 'new' })

    await manager().mergeBaseWithBase()

    expect((await clone.raw(['rev-parse', 'refs/remotes/origin/main'])).trim()).toBe(trackingBefore)
    expect(await clone.raw(['for-each-ref'])).toBe(refsBefore)
    expect(await fs.readFile(fetchHead, 'utf8')).toBe('pinned by another fetch\n')
  })

  it('throws when the remote has no base branch', async () => {
    await openBareRepo(remotePath).raw(['update-ref', '-d', 'refs/heads/main'])
    await expect(manager().mergeBaseWithBase()).rejects.toThrow(/has no branch 'main'/)
  })

  it('is undefined when HEAD shares no history with the base', async () => {
    await clone.raw(['checkout', '-q', '--orphan', 'unrelated'])
    await clone.raw(['commit', '-q', '-m', 'unrelated root'])
    expect(await manager().mergeBaseWithBase()).toBeUndefined()
  })

  it('throws when the remote cannot be read', async () => {
    await fs.rm(remotePath, { recursive: true, force: true })
    await expect(manager().mergeBaseWithBase()).rejects.toThrow()
  })
})

describe('GitManager.diffNameStatusAgainst and listUntrackedFiles', () => {
  const sorted = (changes: Array<{ status: string; path: string }>) =>
    [...changes].sort((a, b) => a.path.localeCompare(b.path))

  it('reports working-tree, committed and staged changes against the commit, never writing the index', async () => {
    const base = (await clone.revparse(['HEAD'])).trim()
    await write(clonePath, 'content/a.md', 'committed edit')
    await clone.raw(['commit', '-qam', 'edit'])
    await write(clonePath, 'content/b c.md', 'saved, not committed')
    await fs.rm(path.join(clonePath, 'other/x.md'))
    await write(clonePath, 'content/staged.md', 'staged')
    await clone.raw(['add', '--', 'content/staged.md'])
    await write(clonePath, 'content/new.md', 'untracked')
    const indexBefore = (await fs.stat(path.join(clonePath, '.git/index'))).mtimeMs

    expect(sorted(await manager().diffNameStatusAgainst(base))).toEqual([
      { status: 'M', path: 'content/a.md' },
      { status: 'M', path: 'content/b c.md' },
      { status: 'A', path: 'content/staged.md' },
      { status: 'D', path: 'other/x.md' },
    ])
    expect(await manager().listUntrackedFiles()).toEqual(['content/new.md'])
    expect((await fs.stat(path.join(clonePath, '.git/index'))).mtimeMs).toBe(indexBefore)
  })

  it('drops a file whose stat changed but whose content did not', async () => {
    const base = (await clone.revparse(['HEAD'])).trim()
    const later = new Date(Date.now() + 60_000)
    await fs.utimes(path.join(clonePath, 'content/a.md'), later, later)
    await fs.utimes(path.join(clonePath, 'content/-dash.md'), later, later)
    await write(clonePath, 'top.txt', 'changed')
    const indexBefore = (await fs.stat(path.join(clonePath, '.git/index'))).mtimeMs
    expect(await manager().diffNameStatusAgainst(base)).toEqual([{ status: 'M', path: 'top.txt' }])
    // `git diff` would refresh these stat-only entries and write the index back.
    expect((await fs.stat(path.join(clonePath, '.git/index'))).mtimeMs).toBe(indexBefore)
  })

  it('hashes a stat-only symlink as git does, and reports a retargeted one', async () => {
    await fs.symlink('a.md', path.join(clonePath, 'content/link'))
    await fs.symlink('a.md', path.join(clonePath, 'content/moved-link'))
    await clone.raw(['add', '--', 'content/link', 'content/moved-link'])
    await clone.raw(['commit', '-qm', 'links'])
    const base = (await clone.revparse(['HEAD'])).trim()
    const later = new Date(Date.now() + 60_000)
    await fs.lutimes(path.join(clonePath, 'content/link'), later, later)
    await fs.rm(path.join(clonePath, 'content/moved-link'))
    await fs.symlink('b c.md', path.join(clonePath, 'content/moved-link'))
    await fs.lutimes(path.join(clonePath, 'content/moved-link'), later, later)
    expect(await manager().diffNameStatusAgainst(base)).toEqual([
      { status: 'M', path: 'content/moved-link' },
    ])
  })

  it('counts a file that vanishes mid-read, or that git cannot hash, as changed, and no other', async () => {
    const base = (await clone.revparse(['HEAD'])).trim()
    const later = new Date(Date.now() + 60_000)
    for (const file of ['content/a.md', 'content/b c.md', 'content/-dash.md', 'top.txt']) {
      await fs.utimes(path.join(clonePath, file), later, later)
    }
    await fs.chmod(path.join(clonePath, 'top.txt'), 0o000)
    const original = fs.lstat
    vi.spyOn(fs, 'lstat').mockImplementation(async (target, ...rest) => {
      if (String(target).endsWith('b c.md')) await fs.rm(String(target), { force: true })
      return original(target, ...(rest as []))
    })
    try {
      expect(
        [...(await manager().diffNameStatusAgainst(base))].sort((a, b) =>
          a.path.localeCompare(b.path),
        ),
      ).toEqual([
        { status: 'M', path: 'content/b c.md' },
        { status: 'M', path: 'top.txt' },
      ])
    } finally {
      await fs.chmod(path.join(clonePath, 'top.txt'), 0o644)
    }
  })

  it('leaves out ignored files from the untracked list', async () => {
    await write(clonePath, '.gitignore', 'ignored.md\n')
    await write(clonePath, 'ignored.md', 'x')
    expect(await manager().listUntrackedFiles()).toEqual(['.gitignore'])
  })

  it('reports nothing outside a sparse clone’s cone', async () => {
    const base = (await clone.revparse(['HEAD'])).trim()
    await manager().setSparseCone(['content'])
    await expect(fs.stat(path.join(clonePath, 'other/x.md'))).rejects.toThrow()
    await write(clonePath, 'content/a.md', 'edit')
    expect(await manager().diffNameStatusAgainst(base)).toEqual([
      { status: 'M', path: 'content/a.md' },
    ])
    expect(await manager().listUntrackedFiles()).toEqual([])
  })
})

describe('GitManager.showFile', () => {
  it("returns a file's text at a commit, a path with a space or a leading dash included", async () => {
    const base = (await clone.revparse(['HEAD'])).trim()
    await fs.rm(path.join(clonePath, 'content/a.md'))
    expect(await manager().showFile(base, 'content/a.md')).toBe('a')
    expect(await manager().showFile(base, 'content/b c.md')).toBe('b')
    expect(await manager().showFile(base, 'content/-dash.md')).toBe('dash')
  })

  it('is undefined for a path the commit lacks, whether or not it exists on disk', async () => {
    const base = (await clone.revparse(['HEAD'])).trim()
    expect(await manager().showFile(base, 'content/missing.md')).toBeUndefined()
    await write(clonePath, 'content/new.md', 'on disk only')
    expect(await manager().showFile(base, 'content/new.md')).toBeUndefined()
  })

  it('throws for an unknown commit', async () => {
    await expect(manager().showFile('0123456789abcdef0123', 'content/a.md')).rejects.toThrow()
  })
})
