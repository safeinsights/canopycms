import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { simpleGit } from 'simple-git'

import { detectHeadBranch, resolveBaseBranch } from './git'

const tmpDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'canopycms-utilsgit-'))

/** Create a repo with one commit on `main` and check out the given branch. */
async function initRepo(branch = 'main'): Promise<string> {
  const root = await tmpDir()
  const git = simpleGit({ baseDir: root })
  await git.init(['--initial-branch=main'])
  await git.addConfig('user.name', 'Test')
  await git.addConfig('user.email', 'test@test.com')
  await fs.writeFile(path.join(root, 'README.md'), '# test\n')
  await git.add('-A')
  await git.commit('initial commit')
  if (branch !== 'main') {
    await git.checkoutLocalBranch(branch)
  }
  return root
}

describe('detectHeadBranch', () => {
  it('returns the checked-out branch', async () => {
    const root = await initRepo('feature-z')
    expect(await detectHeadBranch(root)).toBe('feature-z')
  })

  it('returns the fallback on detached HEAD', async () => {
    const root = await initRepo()
    const git = simpleGit({ baseDir: root })
    await git.checkout(['--detach'])
    expect(await detectHeadBranch(root)).toBe('main')
    expect(await detectHeadBranch(root, 'develop')).toBe('develop')
  })

  it('returns the fallback outside a git repo', async () => {
    const root = await tmpDir()
    expect(await detectHeadBranch(root, 'develop')).toBe('develop')
  })
})

describe('resolveBaseBranch', () => {
  it('explicit defaultBaseBranch always wins, in both modes', async () => {
    const root = await initRepo('feature-z')
    expect(
      await resolveBaseBranch({ defaultBaseBranch: 'develop', mode: 'dev', detectFrom: root }),
    ).toBe('develop')
    expect(
      await resolveBaseBranch({ defaultBaseBranch: 'develop', mode: 'prod', detectFrom: root }),
    ).toBe('develop')
  })

  it('dev mode detects the checked-out branch when unset', async () => {
    const root = await initRepo('feature-z')
    expect(await resolveBaseBranch({ mode: 'dev', detectFrom: root })).toBe('feature-z')
  })

  it('dev mode falls back to main on detached HEAD', async () => {
    const root = await initRepo()
    const git = simpleGit({ baseDir: root })
    await git.checkout(['--detach'])
    expect(await resolveBaseBranch({ mode: 'dev', detectFrom: root })).toBe('main')
  })

  it('prod mode never detects and defaults to main', async () => {
    const root = await initRepo('feature-z')
    expect(await resolveBaseBranch({ mode: 'prod', detectFrom: root })).toBe('main')
  })
})
