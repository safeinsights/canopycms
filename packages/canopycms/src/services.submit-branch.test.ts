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
import { ContentWriteLockBusyError, tryAcquireContentWriteLock } from './utils/content-write-lock'

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
      await fs.writeFile(path.join(localPath, '.canopy-meta', 'branch.json'), '{}', 'utf8')
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
}, 30_000)
