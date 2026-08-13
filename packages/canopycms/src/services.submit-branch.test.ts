import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simpleGit } from 'simple-git'

import { createTestServices } from './config-test'
import { GitManager, ensureGitExcludePattern } from './git-manager'
import { initTestRepo, openBareRepo } from './test-utils'
import type { BranchContext } from './types'
import type { CanopyServices } from './services'

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

  it('a never-pushed branch with a clean tree still pushes', async () => {
    // No file changes -> the tree is clean immediately after checkout, but
    // this branch (created fresh from origin/main) has never reached the
    // mirror under its own name.
    await services.submitBranch({ context, message: 'no changes, first submit' })

    expect(await remoteBranchSha('feature-1')).toBe(await localSha())
  })
}, 30_000)
