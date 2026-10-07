/**
 * `GitManager.cloneRepo`'s single retry. A clone that loses a race with the
 * worker's repack cannot be staged with real git, so simple-git's `clone` is
 * wrapped to fail a set number of times, leaving a partial `.git` behind as a
 * killed clone would.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { simpleGit, type SimpleGit } from 'simple-git'

import { GitManager } from './git-manager'
import { initTestRepo, mockConsole } from './test-utils'

const injected = vi.hoisted(() => ({ failures: 0, attempts: 0 }))

vi.mock('simple-git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('simple-git')>()
  const wrapped = (...args: Parameters<typeof actual.simpleGit>): SimpleGit => {
    const git = actual.simpleGit(...args)
    const realClone = git.clone.bind(git)
    const clone = async (repo: string, localPath: string, options?: string[]) => {
      injected.attempts++
      if (injected.failures > 0) {
        injected.failures--
        await fs.mkdir(path.join(localPath, '.git', 'objects'), { recursive: true })
        await fs.writeFile(path.join(localPath, '.git', 'config.lock'), '')
        throw new Error('fatal: packfile vanished during clone')
      }
      return realClone(repo, localPath, options ?? [])
    }
    return Object.assign(git, { clone })
  }
  return { ...actual, simpleGit: wrapped }
})

let tmpDir: string
let remotePath: string

beforeEach(async () => {
  injected.failures = 0
  injected.attempts = 0
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canopy-clone-retry-'))
  const sourceDir = path.join(tmpDir, 'source')
  await fs.mkdir(sourceDir)
  const source = await initTestRepo(sourceDir)
  await source.raw(['branch', '-M', 'main'])
  await fs.writeFile(path.join(sourceDir, 'README.md'), '# hi\n')
  await source.add('.')
  await source.commit('initial')
  remotePath = path.join(tmpDir, 'remote.git')
  await simpleGit().raw(['clone', '-q', '--bare', sourceDir, remotePath])
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function headOf(repo: string): Promise<string> {
  return (await simpleGit({ baseDir: repo }).raw(['symbolic-ref', '--short', 'HEAD'])).trim()
}

describe('GitManager.cloneRepo retry', () => {
  it('retries a failed clone once, clearing what the failed attempt left', async () => {
    const consoleSpy = mockConsole()
    injected.failures = 1
    const target = path.join(tmpDir, 'ws')

    await GitManager.cloneRepo(remotePath, target, 'main')

    expect(injected.attempts).toBe(2)
    expect(await headOf(target)).toBe('main')
    await expect(fs.access(path.join(target, '.git', 'config.lock'))).rejects.toThrow()
    expect(consoleSpy).toHaveWarned(/retrying once: fatal: packfile vanished/)
    consoleSpy.restore()
  })

  it('keeps an empty target directory the caller created', async () => {
    const consoleSpy = mockConsole()
    injected.failures = 1
    const target = path.join(tmpDir, 'ws')
    await fs.mkdir(target)

    await GitManager.cloneRepo(remotePath, target, 'main')

    expect(injected.attempts).toBe(2)
    expect(await headOf(target)).toBe('main')
    consoleSpy.restore()
  })

  it('never retries into, or clears, a target that already held files', async () => {
    injected.failures = 1
    const target = path.join(tmpDir, 'ws')
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, 'keep.txt'), 'keep')

    await expect(GitManager.cloneRepo(remotePath, target, 'main')).rejects.toThrow(
      /packfile vanished/,
    )

    expect(injected.attempts).toBe(1)
    expect(await fs.readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('gives up after the second failure', async () => {
    const consoleSpy = mockConsole()
    injected.failures = 2
    const target = path.join(tmpDir, 'ws')

    await expect(GitManager.cloneRepo(remotePath, target, 'main')).rejects.toThrow(
      /packfile vanished/,
    )

    expect(injected.attempts).toBe(2)
    consoleSpy.restore()
  })
})
