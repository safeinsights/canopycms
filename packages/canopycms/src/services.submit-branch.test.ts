import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simpleGit } from 'simple-git'

import { createTestServices } from './config-test'
import { GitManager, ensureGitExcludePattern } from './git-manager'
import { initTestRepo, mockConsole, openBareRepo } from './test-utils'
import type { BranchContext } from './types'
import { NothingToSubmitError, type CanopyServices } from './services'
import { BranchMetadataFileManager } from './branch-metadata'
import { ContentWriteLockBusyError, tryAcquireContentWriteLock } from './utils/content-write-lock'
import { ContentConflictError, ContentStore } from './content-store'
import { listEntries } from './content-listing'
import { flattenSchema } from './config/flatten'
import { generateId } from './id'
import type { LogicalPath, Slug } from './paths/types'

// Deliberately does NOT mock 'simple-git' (unlike services.test.ts) -- this
// bug is about the interaction between real git state (a commit landing
// locally while cleaning the tree) and a subsequent push, which a mocked git
// client can't reproduce. Real temp repos, following git-manager.test.ts's
// pattern.

const testSchema = {
  collections: [
    {
      name: 'pages',
      path: 'pages',
      entries: [
        {
          name: 'page',
          format: 'md' as const,
          schema: [{ name: 'title', type: 'string' as const }],
        },
      ],
    },
  ],
}

describe('services submitBranch', () => {
  let tmpDir: string
  let remotePath: string
  let localPath: string
  let services: CanopyServices
  let context: BranchContext

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-submit-branch-'))
    remotePath = path.join(tmpDir, 'remote.git')
    localPath = path.join(tmpDir, 'branch')

    // Bare mirror ("remote.git") -- set HEAD before any pushes so clones
    // know the default branch.
    await fs.mkdir(remotePath, { recursive: true })
    const bareGit = openBareRepo(remotePath)
    await bareGit.init(true)
    await bareGit.raw(['symbolic-ref', 'HEAD', 'refs/heads/main'])

    // Seed the mirror with an initial commit on main.
    const seedPath = path.join(tmpDir, 'seed')
    await fs.mkdir(seedPath, { recursive: true })
    const seedGit = await initTestRepo(seedPath)
    await seedGit.raw(['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await fs.writeFile(path.join(seedPath, 'seed.txt'), 'seed', 'utf8')
    await seedGit.add(['.'])
    await seedGit.commit('initial commit')
    await seedGit.addRemote('origin', remotePath)
    await seedGit.push('origin', 'main')

    // Local single-branch clone of just `main`, mirroring how real branch
    // workspaces are provisioned -- the remote-tracking ref for any OTHER
    // branch does not exist in this clone.
    await simpleGit().clone(remotePath, localPath, ['--branch', 'main', '--single-branch'])
    const localRaw = simpleGit({ baseDir: localPath })
    await localRaw.addConfig('canopycms.managed', 'true')
    // Real branch workspaces exclude the runtime metadata dir via
    // initializeWorkspace's gitExcludePattern; replicate that here so the
    // content-index generation marker GitManager writes under
    // .canopy-meta/ on every checkout doesn't show up as an untracked file
    // and make every submit look "dirty".
    await ensureGitExcludePattern(localPath, '.canopy-meta/')

    services = await createTestServices({
      schema: testSchema,
      mode: 'dev',
      defaultBaseBranch: 'main',
    })

    context = {
      baseRoot: tmpDir,
      branchRoot: localPath,
      branch: {
        name: 'feature-1',
        baseBranch: 'main',
        status: 'editing',
        access: {},
        createdBy: 'u1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  /** Resolve a branch's SHA on the bare mirror, or undefined if it has no ref there. */
  async function remoteBranchSha(branch: string): Promise<string | undefined> {
    const bare = openBareRepo(remotePath)
    try {
      return (await bare.revparse([branch])).trim()
    } catch {
      return undefined
    }
  }

  async function localSha(): Promise<string> {
    return (await simpleGit({ baseDir: localPath }).revparse(['HEAD'])).trim()
  }

  it('regression: retry after a failed push actually pushes (reproduces at unfixed HEAD)', async () => {
    await fs.writeFile(path.join(localPath, 'a.txt'), 'first change', 'utf8')

    const pushSpy = vi.spyOn(GitManager.prototype, 'push')
    pushSpy.mockRejectedValueOnce(new Error('simulated push failure (EFS blip)'))

    // Attempt 1: dirty tree -> commit succeeds, push fails.
    await expect(services.submitBranch({ context, message: 'attempt 1' })).rejects.toThrow(
      'simulated push failure',
    )

    // The commit landed locally but never reached the mirror; the tree is
    // now clean, which is exactly the trap: a naive dirty-tree gate would
    // skip the push entirely on retry.
    const treeStatus = await simpleGit({ baseDir: localPath }).status()
    expect(treeStatus.files).toHaveLength(0)
    expect(await remoteBranchSha('feature-1')).toBeUndefined()

    // Attempt 2 (retry): tree is clean, but the local branch is still ahead
    // of the mirror -- the push must actually be attempted this time.
    await services.submitBranch({ context, message: 'attempt 2 (retry)' })

    const finalLocalSha = await localSha()
    expect(await remoteBranchSha('feature-1')).toBe(finalLocalSha)
  })

  it('retry after a failed push on an already-pushed branch actually pushes', async () => {
    await fs.writeFile(path.join(localPath, 'a.txt'), 'first change', 'utf8')
    await services.submitBranch({ context, message: 'first submit' })
    const firstPushedSha = await remoteBranchSha('feature-1')
    expect(firstPushedSha).toBe(await localSha())

    await fs.writeFile(path.join(localPath, 'a.txt'), 'second change', 'utf8')
    const pushSpy = vi.spyOn(GitManager.prototype, 'push')
    pushSpy.mockRejectedValueOnce(new Error('simulated push failure (EFS blip)'))
    await expect(services.submitBranch({ context, message: 'attempt 1' })).rejects.toThrow(
      'simulated push failure',
    )
    expect((await simpleGit({ baseDir: localPath }).status()).files).toHaveLength(0)
    expect(await remoteBranchSha('feature-1')).toBe(firstPushedSha)

    // Clean tree, branch already on the mirror, local tip ahead of it: the
    // retry must take the hasUnpushedCommits path and push.
    await services.submitBranch({ context, message: 'attempt 2 (retry)' })

    expect(await remoteBranchSha('feature-1')).toBe(await localSha())
  })

  it('dirty tree, first submit: commits and pushes', async () => {
    await fs.writeFile(path.join(localPath, 'a.txt'), 'content', 'utf8')

    await services.submitBranch({ context, message: 'first submit' })

    expect(await remoteBranchSha('feature-1')).toBe(await localSha())
  })

  it('clean tree with nothing unpushed: does not push again', async () => {
    await fs.writeFile(path.join(localPath, 'a.txt'), 'content', 'utf8')
    await services.submitBranch({ context, message: 'first submit' })

    const pushSpy = vi.spyOn(GitManager.prototype, 'push')
    await services.submitBranch({ context, message: 'second, no-op submit' })

    expect(pushSpy).not.toHaveBeenCalled()
  })

  describe('nothing to submit', () => {
    it('refuses a branch with no changes, pushing nothing', async () => {
      const before = await localSha()

      await expect(services.submitBranch({ context, message: 'no changes' })).rejects.toThrow(
        NothingToSubmitError,
      )

      expect(await localSha()).toBe(before)
      expect(await remoteBranchSha('feature-1')).toBeUndefined()
    })

    it('refuses saved edits that restore the base content, pushing nothing', async () => {
      await fs.writeFile(path.join(localPath, 'a.txt'), 'content', 'utf8')
      await services.submitBranch({ context, message: 'first submit' })
      const pushed = await remoteBranchSha('feature-1')
      await fs.rm(path.join(localPath, 'a.txt'))

      await expect(services.submitBranch({ context, message: 'revert' })).rejects.toThrow(
        'Nothing to submit yet: "feature-1" has no saved changes compared with "main"',
      )

      expect(await remoteBranchSha('feature-1')).toBe(pushed)
      // The refused submit's own commit is undone; the saved deletion stays in the working tree.
      expect(await localSha()).toBe(pushed)
      const tree = await simpleGit({ baseDir: localPath }).status()
      expect(tree.deleted).toEqual(['a.txt'])
      expect(tree.staged).toEqual([])
    })

    it('moves nothing when the commit step committed nothing', async () => {
      // Staged, then deleted: status lists the path, but staging leaves the index at HEAD, so
      // git's commit succeeds without creating one.
      await fs.writeFile(path.join(localPath, 'c.txt'), 'c', 'utf8')
      await simpleGit({ baseDir: localPath }).add(['c.txt'])
      await fs.rm(path.join(localPath, 'c.txt'))
      const before = await localSha()

      await expect(services.submitBranch({ context, message: 'no-op commit' })).rejects.toThrow(
        NothingToSubmitError,
      )

      expect(await localSha()).toBe(before)
      expect((await simpleGit({ baseDir: localPath }).status()).files).toEqual([])
    })

    it('submits when the changes cannot be listed', async () => {
      mockConsole()
      vi.spyOn(GitManager.prototype, 'listChangedPathsSinceBase').mockRejectedValue(
        new Error('simulated fetch failure'),
      )

      const result = await services.submitBranch({ context, message: 'no changes' })

      expect(result.changedPaths).toEqual([])
      expect(await remoteBranchSha('feature-1')).toBe(await localSha())
    })
  })
  describe("canopycms's own state", () => {
    const CACHE = '.canopy-meta/schema-cache.json'

    /** Commit `.canopy-meta/schema-cache.json` upstream, as an adopter repo can, and sync the clone to it. */
    async function trackCanopyMetaUpstream(): Promise<string> {
      const seedPath = path.join(tmpDir, 'seed')
      await fs.mkdir(path.join(seedPath, '.canopy-meta'), { recursive: true })
      await fs.writeFile(path.join(seedPath, CACHE), '{"committed":true}', 'utf8')
      const seedGit = simpleGit({ baseDir: seedPath })
      await seedGit.add(['.'])
      await seedGit.commit('adopter commits canopycms state')
      await seedGit.push('origin', 'main')
      const local = simpleGit({ baseDir: localPath })
      await local.fetch('origin', 'main')
      await local.raw(['reset', '--hard', 'origin/main'])
      return localSha()
    }

    async function filesInCommit(sha: string): Promise<string[]> {
      const out = await openBareRepo(remotePath).raw(['show', '--name-only', '--format=', sha])
      return out.split('\n').filter((line) => line.length > 0)
    }

    it('commits the content change but never canopycms state, tracked or not', async () => {
      await trackCanopyMetaUpstream()
      await fs.writeFile(path.join(localPath, CACHE), '{"rewritten":"per branch"}', 'utf8')
      await fs.writeFile(
        path.join(localPath, '.canopy-meta', 'branch.json'),
        JSON.stringify({ branch: { name: 'feature-1', status: 'editing', access: {} } }),
        'utf8',
      )
      await fs.writeFile(path.join(localPath, 'a.txt'), 'content', 'utf8')

      await services.submitBranch({ context, message: 'submit' })

      const pushed = await remoteBranchSha('feature-1')
      expect(pushed).toBe(await localSha())
      expect(await filesInCommit(pushed!)).toEqual(['a.txt'])
      // The state stays on disk, unstaged.
      const status = await simpleGit({ baseDir: localPath }).status()
      expect(status.files.map((f) => `${f.index}${f.working_dir} ${f.path}`)).toEqual([
        ` M ${CACHE}`,
      ])
    })

    it('refuses a submit whose only change is canopycms state, creating no commit', async () => {
      const upstreamSha = await trackCanopyMetaUpstream()
      await fs.writeFile(path.join(localPath, CACHE), '{"rewritten":"per branch"}', 'utf8')

      await expect(services.submitBranch({ context, message: 'submit' })).rejects.toThrow(
        NothingToSubmitError,
      )

      expect(await localSha()).toBe(upstreamSha)
      expect(await remoteBranchSha('feature-1')).toBeUndefined()
    })
  })

  describe('records the submitting user', () => {
    const jane = { userId: 'user_2abc', name: 'Jane Doe', email: 'jane@example.com' }

    async function headCommit(): Promise<{
      message: string
      author: string
      botIdentity: string
      trailers: string
    }> {
      const git = simpleGit({ baseDir: localPath })
      // The identity git resolves for this workspace: the configured bot, or the
      // GIT_AUTHOR_*/GIT_COMMITTER_* env CI sets, which take precedence over it.
      const ident = async (v: string) => (await git.raw(['var', v])).replace(/>.*$/s, '>').trim()
      return {
        message: (await git.raw(['log', '-1', '--format=%B'])).trimEnd(),
        author: (await git.raw(['log', '-1', '--format=%an <%ae> / %cn <%ce>'])).trim(),
        botIdentity: `${await ident('GIT_AUTHOR_IDENT')} / ${await ident('GIT_COMMITTER_IDENT')}`,
        trailers: (await git.raw(['log', '-1', '--format=%(trailers:only,unfold)'])).trim(),
      }
    }

    it('adds an Edited-by trailer with name and id by default, keeping the bot as author', async () => {
      await fs.writeFile(path.join(localPath, 'a.txt'), 'content', 'utf8')

      await services.submitBranch({ context, submitter: jane })

      const commit = await headCommit()
      expect(commit.message).toBe('Submit feature-1\n\nEdited-by: Jane Doe (user_2abc)')
      // git itself parses it as a trailer, not as part of the subject.
      expect(commit.trailers).toBe('Edited-by: Jane Doe (user_2abc)')
      expect(commit.message).not.toContain('jane@example.com')
      expect(commit.author).toBe(commit.botIdentity)
      expect(commit.author).not.toMatch(/Jane|jane@example\.com/)
    })

    it('adds Co-authored-by with the email only when the config opts in', async () => {
      services = await createTestServices({
        schema: testSchema,
        mode: 'dev',
        defaultBaseBranch: 'main',
        gitCoAuthoredByTrailers: true,
      })
      await fs.writeFile(path.join(localPath, 'a.txt'), 'content', 'utf8')

      await services.submitBranch({ context, submitter: jane })

      expect((await headCommit()).trailers).toBe(
        'Edited-by: Jane Doe (user_2abc)\nCo-authored-by: Jane Doe <jane@example.com>',
      )
    })

    it('writes no trailers when Edited-by is turned off and Co-authored-by is not on', async () => {
      services = await createTestServices({
        schema: testSchema,
        mode: 'dev',
        defaultBaseBranch: 'main',
        gitEditedByTrailers: false,
      })
      await fs.writeFile(path.join(localPath, 'a.txt'), 'content', 'utf8')

      await services.submitBranch({ context, submitter: jane })

      expect((await headCommit()).message).toBe('Submit feature-1')
    })

    it('records a submitter with no display name by id', async () => {
      await fs.writeFile(path.join(localPath, 'a.txt'), 'content', 'utf8')

      await services.submitBranch({ context, submitter: { userId: 'user_9xyz' } })

      expect((await headCommit()).trailers).toBe('Edited-by: user_9xyz')
    })

    it('keeps a hostile display name on one trailer line', async () => {
      await fs.writeFile(path.join(localPath, 'a.txt'), 'content', 'utf8')

      await services.submitBranch({
        context,
        submitter: { userId: 'user_1', name: 'Eve\nSigned-off-by: Mallory <m@evil.example>' },
      })

      expect((await headCommit()).trailers).toBe(
        'Edited-by: Eve Signed-off-by: Mallory m＠evil.example (user_1)',
      )
    })
  })

  describe('credits the recorded editors', () => {
    const jane = { userId: 'user_2abc', name: 'Jane Doe', email: 'jane@example.com' }
    const people: Record<string, { id: string; name: string; email: string }> = {
      user_raj: { id: 'user_raj', name: 'Raj Patel', email: 'raj@example.com' },
      user_ana: { id: 'user_ana', name: 'Ana Li', email: 'ana@example.com' },
    }

    async function writeEditors(editors: string[], uncommittedEditors: string[]): Promise<void> {
      await fs.mkdir(path.join(localPath, '.canopy-meta'), { recursive: true })
      await fs.writeFile(
        path.join(localPath, '.canopy-meta', 'branch.json'),
        JSON.stringify({
          branch: { name: 'feature-1', status: 'editing', access: {}, editors, uncommittedEditors },
        }),
        'utf8',
      )
    }

    async function recordedOnDisk(): Promise<{
      editors?: string[]
      uncommittedEditors?: string[]
    }> {
      const raw = await fs.readFile(path.join(localPath, '.canopy-meta', 'branch.json'), 'utf8')
      return (JSON.parse(raw) as { branch: { editors?: string[]; uncommittedEditors?: string[] } })
        .branch
    }

    async function trailers(): Promise<string> {
      const git = simpleGit({ baseDir: localPath })
      return (await git.raw(['log', '-1', '--format=%(trailers:only,unfold)'])).trim()
    }

    it('names the submitter and the uncommitted editors, then clears them', async () => {
      await writeEditors(['user_ana', 'user_raj'], ['user_raj'])
      await fs.writeFile(path.join(localPath, 'a.txt'), 'content', 'utf8')

      const result = await services.submitBranch({
        context,
        submitter: jane,
        lookupEditor: async (id) => people[id] ?? null,
      })

      expect(await trailers()).toBe(
        'Edited-by: Jane Doe (user_2abc)\nEdited-by: Raj Patel (user_raj)',
      )
      expect(result.editors).toEqual([
        { userId: 'user_ana', name: 'Ana Li', email: 'ana@example.com' },
        { userId: 'user_raj', name: 'Raj Patel', email: 'raj@example.com' },
      ])
      const onDisk = await recordedOnDisk()
      expect(onDisk.uncommittedEditors).toBeUndefined()
      expect(onDisk.editors).toEqual(['user_ana', 'user_raj'])
    })

    it('looks editors up without holding the content-write lock', async () => {
      await writeEditors(['user_raj'], ['user_raj'])
      await fs.writeFile(path.join(localPath, 'a.txt'), 'content', 'utf8')
      const lockFreeDuringLookup: boolean[] = []

      await services.submitBranch({
        context,
        submitter: jane,
        lookupEditor: async (id) => {
          const release = await tryAcquireContentWriteLock(localPath).catch(() => undefined)
          lockFreeDuringLookup.push(release !== undefined)
          await release?.()
          return people[id] ?? null
        },
      })

      expect(lockFreeDuringLookup).toEqual([true])
      expect(await trailers()).toContain('Edited-by: Raj Patel (user_raj)')
    })

    it('keeps the uncommitted editors when a commit is undone for having nothing to submit', async () => {
      await fs.writeFile(path.join(localPath, 'a.txt'), 'content', 'utf8')
      await services.submitBranch({ context, message: 'first submit' })
      await fs.rm(path.join(localPath, 'a.txt'))
      await writeEditors(['user_raj'], ['user_raj'])

      await expect(services.submitBranch({ context, submitter: jane })).rejects.toThrow(
        NothingToSubmitError,
      )

      expect((await recordedOnDisk()).uncommittedEditors).toEqual(['user_raj'])
    })

    it('names, by id, an editor recorded after the names were looked up', async () => {
      await writeEditors(['user_raj'], ['user_raj'])
      await fs.writeFile(path.join(localPath, 'a.txt'), 'content', 'utf8')

      await services.submitBranch({
        context,
        submitter: jane,
        lookupEditor: async (id) => {
          if (id === 'user_raj')
            await writeEditors(['user_raj', 'user_late'], ['user_raj', 'user_late'])
          return people[id] ?? null
        },
      })

      expect(await trailers()).toBe(
        'Edited-by: Jane Doe (user_2abc)\nEdited-by: Raj Patel (user_raj)\nEdited-by: user_late',
      )
    })

    it('lists in the PR an editor recorded after the commit read the editors', async () => {
      await writeEditors(['user_raj'], ['user_raj'])
      await fs.writeFile(path.join(localPath, 'a.txt'), 'content', 'utf8')
      const markCommitted = BranchMetadataFileManager.prototype.markEditorsCommitted
      vi.spyOn(BranchMetadataFileManager.prototype, 'markEditorsCommitted').mockImplementation(
        async function (this: BranchMetadataFileManager, ids) {
          await markCommitted.call(this, ids)
          await writeEditors(['user_raj', 'user_ana'], ['user_ana'])
        },
      )

      const result = await services.submitBranch({
        context,
        submitter: jane,
        lookupEditor: async (id) => people[id] ?? null,
      })

      expect(await trailers()).not.toContain('user_ana')
      expect(result.editors.map((e) => e.userId)).toEqual(['user_raj', 'user_ana'])
    })

    it('credits an editor by id when the lookup finds no one', async () => {
      await writeEditors(['user_gone'], ['user_gone'])
      await fs.writeFile(path.join(localPath, 'a.txt'), 'content', 'utf8')

      const result = await services.submitBranch({
        context,
        lookupEditor: async () => null,
      })

      expect(await trailers()).toBe('Edited-by: user_gone')
      expect(result.editors).toEqual([{ userId: 'user_gone' }])
    })
  })

  describe('changedPaths', () => {
    it('lists every path the branch changes against its base, across submits', async () => {
      await fs.writeFile(path.join(localPath, 'a.txt'), 'first', 'utf8')
      await services.submitBranch({ context })
      await fs.writeFile(path.join(localPath, 'b.txt'), 'second', 'utf8')

      const result = await services.submitBranch({ context })

      expect(result.changedPaths.sort()).toEqual(['a.txt', 'b.txt'])
    })

    it('excludes canopycms runtime metadata', async () => {
      await fs.writeFile(path.join(localPath, 'a.txt'), 'first', 'utf8')
      vi.spyOn(GitManager.prototype, 'listChangedPathsSinceBase').mockResolvedValue([
        'a.txt',
        '.canopy-meta/branch.json',
      ])

      const result = await services.submitBranch({ context })

      expect(result.changedPaths).toEqual(['a.txt'])
    })

    it("falls back to this submit's own changes, with a warning, when the base cannot be read", async () => {
      const consoleSpy = mockConsole()
      await fs.writeFile(path.join(localPath, 'a.txt'), 'first', 'utf8')
      vi.spyOn(GitManager.prototype, 'listChangedPathsSinceBase').mockRejectedValue(
        new Error('fetch failed'),
      )

      const result = await services.submitBranch({ context })

      expect(result.changedPaths).toEqual(['a.txt'])
      expect(await remoteBranchSha('feature-1')).toBe(await localSha())
      expect(consoleSpy).toHaveWarned('Could not list the changes on feature-1')
      consoleSpy.restore()
    })
  })

  describe('[SYNC-C1] content-write lock', () => {
    async function headBranch(): Promise<string> {
      return (await simpleGit({ baseDir: localPath }).revparse(['--abbrev-ref', 'HEAD'])).trim()
    }

    it('neither checks out, commits nor pushes while the lock is held, then submits once it is free', async () => {
      await fs.writeFile(path.join(localPath, 'a.txt'), 'editor save', 'utf8')
      const shaBefore = await localSha()
      const branchBefore = await headBranch()

      const release = await tryAcquireContentWriteLock(localPath)
      try {
        await expect(services.submitBranch({ context })).rejects.toBeInstanceOf(
          ContentWriteLockBusyError,
        )
        expect(await headBranch()).toBe(branchBefore)
        expect(await localSha()).toBe(shaBefore)
        expect(await remoteBranchSha('feature-1')).toBeUndefined()
        const dirty = (await simpleGit({ baseDir: localPath }).status()).files.map((f) => f.path)
        expect(dirty).toContain('a.txt')
      } finally {
        await release()
      }

      await services.submitBranch({ context })
      expect(await localSha()).not.toBe(shaBefore)
      expect(await remoteBranchSha('feature-1')).toBe(await localSha())
    })

    it('holds the lock through the push', async () => {
      await fs.writeFile(path.join(localPath, 'a.txt'), 'editor save', 'utf8')
      const realPush = GitManager.prototype.push
      let lockStateAtPush: unknown
      vi.spyOn(GitManager.prototype, 'push').mockImplementation(async function (
        this: GitManager,
        branch?: string,
      ) {
        lockStateAtPush = await tryAcquireContentWriteLock(localPath).then(
          async (release) => {
            await release()
            return 'free'
          },
          (err: unknown) => (err as NodeJS.ErrnoException).code,
        )
        return realPush.call(this, branch)
      })

      await services.submitBranch({ context })

      expect(lockStateAtPush).toBe('ELOCKED')
      // Released afterwards.
      const release = await tryAcquireContentWriteLock(localPath)
      await release()
    })

    it('commitFiles refuses to commit while the lock is held, then commits once it is free', async () => {
      await fs.writeFile(path.join(localPath, 'a.txt'), 'editor save', 'utf8')
      const shaBefore = await localSha()
      const commit = () => services.commitFiles({ context, files: 'a.txt', message: 'commit a' })

      const release = await tryAcquireContentWriteLock(localPath)
      try {
        await expect(commit()).rejects.toBeInstanceOf(ContentWriteLockBusyError)
        expect(await localSha()).toBe(shaBefore)
      } finally {
        await release()
      }

      await commit()
      expect(await localSha()).not.toBe(shaBefore)
    })
  })

  describe('stampOnPublish', () => {
    const title = { name: 'title', type: 'string' as const }
    const stamp = { name: 'publishedAt', type: 'datetime' as const, stampOnPublish: true }
    const post = {
      name: 'post',
      format: 'md' as const,
      schema: [title, stamp, { name: 'body', type: 'markdown' as const, isBody: true }],
    }
    const stampSchema = {
      collections: [
        {
          name: 'posts',
          path: 'posts',
          entries: [
            post,
            {
              name: 'note',
              format: 'yaml' as const,
              schema: [title, { name: 'meta', type: 'group' as const, fields: [stamp] }],
            },
            { name: 'card', format: 'json' as const, schema: [title, stamp] },
            {
              name: 'release',
              format: 'json' as const,
              schema: [stamp, { ...stamp, name: 'announcedAt' }],
            },
          ],
        },
        { name: 'news', path: 'news', entries: [post] },
        {
          name: 'pages',
          path: 'pages',
          entries: [
            {
              name: 'page',
              format: 'md' as const,
              schema: [title, { name: 'publishedAt', type: 'datetime' as const }],
            },
          ],
        },
      ],
    }
    const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

    beforeEach(async () => {
      services = await createTestServices({
        schema: stampSchema,
        mode: 'dev',
        defaultBaseBranch: 'main',
      })
    })

    const entryPath = (collection: string, type: string, slug: string, id: string, ext: string) =>
      `content/${collection}/${type}.${slug}.${id}.${ext}`

    async function writeEntry(relativePath: string, text: string): Promise<void> {
      await fs.mkdir(path.dirname(path.join(localPath, relativePath)), { recursive: true })
      await fs.writeFile(path.join(localPath, relativePath), text, 'utf8')
    }

    const readEntry = (relativePath: string) =>
      fs.readFile(path.join(localPath, relativePath), 'utf8')

    /** The file as the pushed branch holds it. */
    const pushedEntry = (relativePath: string) =>
      openBareRepo(remotePath).raw(['show', `feature-1:${relativePath}`])

    /** Commit everything in the clone to main and push it, making it the base. */
    async function commitToBase(): Promise<void> {
      const git = simpleGit({ baseDir: localPath })
      await git.add(['.'])
      await git.commit('base content')
      await git.push('origin', 'main')
    }

    /** What `text` holds where `template` holds STAMP, failing unless every other byte matches. */
    function stampIn(text: string, template: string): string {
      const [before, after] = template.split('STAMP')
      expect(text.startsWith(before) && text.endsWith(after), text).toBe(true)
      return text.slice(before.length, text.length - after.length)
    }

    it("stamps a new entry's empty field with the submit's time, committed and pushed", async () => {
      const file = entryPath('posts', 'post', 'hello', generateId(), 'md')
      await writeEntry(file, "---\ntitle: Hello\npublishedAt: ''\n---\nBody\n")
      const before = Date.now()

      await services.submitBranch({ context })

      const stamped = stampIn(
        await readEntry(file),
        "---\ntitle: Hello\npublishedAt: 'STAMP'\n---\nBody\n",
      )
      expect(stamped).toMatch(ISO_UTC)
      expect(Date.parse(stamped)).toBeGreaterThanOrEqual(before)
      expect(Date.parse(stamped)).toBeLessThanOrEqual(Date.now())
      expect(await pushedEntry(file)).toBe(await readEntry(file))
      expect((await simpleGit({ baseDir: localPath }).status()).files).toEqual([])
    })

    it('reports each stamped entry with the version a save must then send', async () => {
      const id = generateId()
      const file = entryPath('posts', 'post', 'reported', id, 'md')
      await writeEntry(file, "---\ntitle: Reported\npublishedAt: ''\n---\nBody\n")
      const store = new ContentStore(localPath, flattenSchema(stampSchema, 'content'))
      const read = () => store.read('content/posts' as LogicalPath, 'reported' as Slug)
      const before = (await read()).version!
      await new Promise((resolve) => setTimeout(resolve, 5))

      const { stamped } = await services.submitBranch({ context })

      const value = stampIn(
        await readEntry(file),
        "---\ntitle: Reported\npublishedAt: 'STAMP'\n---\nBody\n",
      )
      const after = (await read()).version!
      expect(stamped).toEqual([
        { contentId: id, fields: { publishedAt: value }, previousVersion: before, version: after },
      ])
      const save = (expectedVersion: number) =>
        store.write('content/posts' as LogicalPath, 'reported' as Slug, {
          format: 'md',
          data: { title: 'Saved', publishedAt: value },
          body: 'Body\n',
          expectedVersion,
        })
      await expect(save(before)).rejects.toThrow(ContentConflictError)
      await expect(save(after)).resolves.toMatchObject({ data: { title: 'Saved' } })
    })

    it('reports an entry with two stamp fields once, at the version after both', async () => {
      const id = generateId()
      const file = entryPath('posts', 'release', 'two', id, 'json')
      await writeEntry(file, '{ "publishedAt": "", "announcedAt": "" }\n')

      const { stamped } = await services.submitBranch({ context })

      const { mtimeMs } = await fs.stat(path.join(localPath, file))
      const value = stamped[0]?.fields.publishedAt
      expect(stamped).toEqual([
        {
          contentId: id,
          fields: { publishedAt: value, announcedAt: value },
          previousVersion: expect.any(Number),
          version: mtimeMs,
        },
      ])
      expect(await readEntry(file)).toBe(
        `{ "publishedAt": "${value}", "announcedAt": "${value}" }\n`,
      )
    })

    it('keeps every other byte of YAML, frontmatter and JSON entries, with one value per submit', async () => {
      const md = entryPath('posts', 'post', 'styled', generateId(), 'md')
      const yaml = entryPath('posts', 'note', 'styled', generateId(), 'yaml')
      const json = entryPath('posts', 'card', 'styled', generateId(), 'json')
      const mdTemplate =
        '---\n# leading comment\ntitle:   "Hello"   # trailing comment\npublishedAt: \'STAMP\'\n' +
        'updated: 2024-01-01\ntags: [a,  b]\n---\n\nBody with *emphasis*   and spaces  \n\n- item\n'
      const yamlTemplate = '# a note\ntitle: Note   # c\npublishedAt: "STAMP"\nextra:\n  -   x\n'
      const jsonTemplate =
        '{\n    "title": "Card",\n    "publishedAt": "STAMP",\n    "n": [1,2,  3]\n}'
      await writeEntry(md, mdTemplate.replace('STAMP', ''))
      await writeEntry(yaml, yamlTemplate.replace('STAMP', ''))
      await writeEntry(json, jsonTemplate.replace('STAMP', ''))

      await services.submitBranch({ context })

      const values = [
        stampIn(await readEntry(md), mdTemplate),
        stampIn(await readEntry(yaml), yamlTemplate),
        stampIn(await readEntry(json), jsonTemplate),
      ]
      expect(values[0]).toMatch(ISO_UTC)
      expect(values).toEqual([values[0], values[0], values[0]])
    })

    it('adds an absent field, which every reader reads back as a string', async () => {
      const md = entryPath('posts', 'post', 'bare', generateId(), 'md')
      const json = entryPath('posts', 'card', 'bare', generateId(), 'json')
      const yaml = entryPath('posts', 'note', 'bare', generateId(), 'yaml')
      await writeEntry(md, '---\ntitle: Bare # c\n---\nBody\n')
      await writeEntry(json, '{\n  "title": "Bare"\n}\n')
      await writeEntry(yaml, 'title: Bare # c\n')

      await services.submitBranch({ context })

      const value = stampIn(
        await readEntry(md),
        "---\ntitle: Bare # c\npublishedAt: 'STAMP'\n---\nBody\n",
      )
      expect(value).toMatch(ISO_UTC)
      expect(await readEntry(json)).toBe(`{\n  "title": "Bare",\n  "publishedAt": "${value}"\n}\n`)
      expect(await readEntry(yaml)).toBe(`title: Bare # c\npublishedAt: ${value}\n`)
      const flatSchema = flattenSchema(stampSchema, 'content')
      const doc = await new ContentStore(localPath, flatSchema).read(
        'content/posts' as LogicalPath,
        'bare' as Slug,
      )
      expect(doc.data.publishedAt).toBe(value)
      const listed = await listEntries(localPath, flatSchema, 'content')
      expect(listed.map((e) => e.data.publishedAt)).toEqual([value, value, value])
    })

    it('never stamps an entry the base has, even renamed or moved, nor a field without the flag', async () => {
      const kept = entryPath('posts', 'post', 'kept', generateId(), 'md')
      const renamedId = generateId()
      const movedId = generateId()
      const page = entryPath('pages', 'page', 'about', generateId(), 'md')
      const empty = (t: string) => `---\ntitle: ${t}\npublishedAt: ''\n---\nBody\n`
      await writeEntry(kept, empty('Kept'))
      await writeEntry(entryPath('posts', 'post', 'old-slug', renamedId, 'md'), empty('Renamed'))
      await writeEntry(entryPath('posts', 'post', 'moved', movedId, 'md'), empty('Moved'))
      await commitToBase()
      const clone = simpleGit({ baseDir: localPath })
      await clone.raw([
        'mv',
        entryPath('posts', 'post', 'old-slug', renamedId, 'md'),
        entryPath('posts', 'post', 'new-slug', renamedId, 'md'),
      ])
      await fs.mkdir(path.join(localPath, 'content/news'), { recursive: true })
      await clone.raw([
        'mv',
        entryPath('posts', 'post', 'moved', movedId, 'md'),
        entryPath('news', 'post', 'moved', movedId, 'md'),
      ])
      await writeEntry(page, empty('About'))
      const readFile = vi.spyOn(fs, 'readFile')

      const result = await services.submitBranch({ context })

      expect(result.stamped).toEqual([])
      // Entries the base has are not even read.
      const read = readFile.mock.calls.map(([file]) => String(file))
      expect(read.filter((file) => file.includes(renamedId) || file.includes('kept'))).toEqual([])
      expect(await readEntry(kept)).toBe(empty('Kept'))
      expect(await readEntry(entryPath('posts', 'post', 'new-slug', renamedId, 'md'))).toBe(
        empty('Renamed'),
      )
      expect(await readEntry(entryPath('news', 'post', 'moved', movedId, 'md'))).toBe(
        empty('Moved'),
      )
      expect(await readEntry(page)).toBe(empty('About'))
    })

    it("judges newness by the base's entry files, not its collection directories", async () => {
      const id = generateId()
      await writeEntry(`content/archive.${id}/readme.txt`, 'a directory carrying the id')
      await commitToBase()
      const file = entryPath('posts', 'post', 'fresh', id, 'md')
      await writeEntry(file, "---\ntitle: Fresh\npublishedAt: ''\n---\nBody\n")

      await services.submitBranch({ context })

      expect(
        stampIn(await readEntry(file), "---\ntitle: Fresh\npublishedAt: 'STAMP'\n---\nBody\n"),
      ).toMatch(ISO_UTC)
    })

    it('keeps a value an editor set', async () => {
      const files: Array<[string, string]> = [
        [
          entryPath('posts', 'post', 'dated', generateId(), 'md'),
          "---\ntitle: Dated\npublishedAt: '2020-01-02T03:04:05.000Z'\n---\nBody\n",
        ],
        [
          entryPath('posts', 'note', 'dated', generateId(), 'yaml'),
          'title: Dated\npublishedAt: 2020-01-02T03:04:05.000Z\n',
        ],
        [
          entryPath('posts', 'card', 'dated', generateId(), 'json'),
          '{ "title": "Dated", "publishedAt": "2020-01-02T03:04:05.000Z" }\n',
        ],
      ]
      for (const [file, text] of files) await writeEntry(file, text)

      await services.submitBranch({ context })

      for (const [file, text] of files) expect(await readEntry(file)).toBe(text)
    })

    it("keeps the first submit's date on a resubmit", async () => {
      const file = entryPath('posts', 'post', 'again', generateId(), 'md')
      const template = "---\ntitle: TITLE\npublishedAt: 'STAMP'\n---\nBody\n"
      await writeEntry(file, template.replace('TITLE', 'First').replace('STAMP', ''))
      await services.submitBranch({ context })
      const first = stampIn(await readEntry(file), template.replace('TITLE', 'First'))
      await new Promise((resolve) => setTimeout(resolve, 5))
      await writeEntry(file, template.replace('TITLE', 'Second').replace('STAMP', first))

      await services.submitBranch({ context })

      expect(await pushedEntry(file)).toBe(
        template.replace('TITLE', 'Second').replace('STAMP', first),
      )
    })

    it('stamps an entry an earlier attempt committed but could not push', async () => {
      const consoleSpy = mockConsole()
      const file = entryPath('posts', 'post', 'retry', generateId(), 'md')
      const template = "---\ntitle: Retry\npublishedAt: 'STAMP'\n---\nBody\n"
      await writeEntry(file, template.replace('STAMP', ''))
      vi.spyOn(GitManager.prototype, 'listBaseTipFiles').mockRejectedValueOnce(
        new Error('simulated fetch failure'),
      )
      vi.spyOn(GitManager.prototype, 'push').mockRejectedValueOnce(
        new Error('simulated push failure'),
      )
      await expect(services.submitBranch({ context })).rejects.toThrow('simulated push failure')
      expect(await readEntry(file)).toBe(template.replace('STAMP', ''))
      expect((await simpleGit({ baseDir: localPath }).status()).files).toEqual([])

      await services.submitBranch({ context })

      expect(stampIn(await pushedEntry(file), template)).toMatch(ISO_UTC)
      consoleSpy.restore()
    })

    it('submits unstamped, with a redacted warning, when the base cannot be read', async () => {
      const consoleSpy = mockConsole()
      const file = entryPath('posts', 'post', 'offline', generateId(), 'md')
      const text = "---\ntitle: Offline\npublishedAt: ''\n---\nBody\n"
      await writeEntry(file, text)
      vi.spyOn(GitManager.prototype, 'listBaseTipFiles').mockRejectedValue(
        new Error('fatal: unable to access https://x-access-token:s3cret@github.com/o/r.git'),
      )

      await services.submitBranch({ context })

      expect(await pushedEntry(file)).toBe(text)
      expect(consoleSpy).toHaveWarned('Could not stamp the new entries on feature-1')
      expect(JSON.stringify(consoleSpy.all().warn)).not.toContain('s3cret')
      consoleSpy.restore()
    })

    it('never reads the base when no entry type stamps', async () => {
      services = await createTestServices({
        schema: testSchema,
        mode: 'dev',
        defaultBaseBranch: 'main',
      })
      const listBase = vi.spyOn(GitManager.prototype, 'listBaseTipFiles')
      await fs.writeFile(path.join(localPath, 'a.txt'), 'content', 'utf8')

      await services.submitBranch({ context })

      expect(listBase).not.toHaveBeenCalled()
    })
  })
}, 30_000)
